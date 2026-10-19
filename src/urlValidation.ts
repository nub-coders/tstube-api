/**
 * Reject unsupported target URLs (SSRF guard)
 * — port of utils/url_validation.py.
 *
 * Supports YouTube, Apple Music, Amazon Music, SoundCloud, JioSaavn, and Spotify hosts,
 * as well as bare search queries.
 */

import net from 'node:net';
import dns from 'node:dns';
import { HttpError } from './httpError.js';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'music.apple.com',
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'jiosaavn.com',
  'www.jiosaavn.com',
  'saavn.com',
  'www.saavn.com',
  'spotify.com',
  'open.spotify.com',
  'www.spotify.com',
]);

export function isAllowedTarget(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return false;
  let parsed: URL;
  try {
    // A bare video id / search phrase has no scheme; URL() would throw, which is
    // exactly the "no scheme" case we allow.
    parsed = new URL(value.trim());
  } catch {
    return true;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const hostname = (parsed.hostname || '').toLowerCase();
    if (ALLOWED_HOSTS.has(hostname)) {
      return true;
    }
    if (hostname.startsWith('music.amazon.')) {
      return true;
    }
    return false;
  }
  // file:, ftp:, etc. — never allowed.
  return false;
}

/** Return `value` if it's an allowed target URL or search phrase, else raise a 400. */
export function validateTarget(value: string): string {
  if (!isAllowedTarget(value)) {
    throw new HttpError(400, { detail: 'Invalid target: only allowed streaming target URLs or search queries permitted' });
  }
  return value;
}

export const validateYoutubeTarget = validateTarget;

// ── Outbound-request host guards (SSRF) ────────────────────────────
// Server-side dials (Webshare API, proxy exits) must only reach public
// http/https hosts — never localhost, loopback, or private/reserved space.

/** True for hostnames that only ever resolve inside the machine or a LAN. */
export function looksLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'broadcasthost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.endsWith('.home.arpa') || h.endsWith('.lan') || h.endsWith('.localdomain')) return true;
  return false;
}

/**
 * True for IPv4/IPv6 addresses in loopback, private, link-local, CGNAT,
 * multicast, or otherwise reserved ranges. Malformed input counts as unsafe.
 */
export function isPrivateAddress(value: string): boolean {
  const s = value.trim().toLowerCase().replace(/%.*$/, ''); // strip IPv6 zone id
  if (!s) return true;

  if (s.includes(':')) {
    // IPv6 (possibly with an embedded IPv4)
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) {
      const mapped = s.slice(7);
      if (mapped.includes('.')) return isPrivateAddress(mapped);
      // Hex form ::ffff:7f00:1 — last two groups are the IPv4 address.
      const groups = mapped.split(':').filter(Boolean);
      if (groups.length >= 2) {
        const hi = Number.parseInt(groups[groups.length - 2]!, 16);
        const lo = Number.parseInt(groups[groups.length - 1]!, 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
      }
      return true;
    }
    if (/^f[de]/.test(s)) return true; // fc00::/7 unique local, fe80::/10 link-local
    if (s.startsWith('ff')) return true; // multicast
    if (s.startsWith('2001:db8')) return true; // documentation range
    return false;
  }

  const parts = s.split('.');
  if (parts.length !== 4) return true; // not a valid dotted quad
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return true;
    const n = Number.parseInt(p, 10);
    if (n > 255) return true;
    octets.push(n);
  }
  const [a, b] = octets as [number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51) return true; // documentation 198.51.100.0/24
  if (a === 203 && b === 0) return true; // documentation 203.0.113.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Resolve `host` and verify every address is public. IP literals are checked
 * directly; names are resolved so a DNS answer pointing at private space is
 * also rejected.
 */
export async function isPublicHost(host: string): Promise<boolean> {
  const h = host.trim().toLowerCase();
  if (!h || looksLocalHostname(h)) return false;
  if (net.isIP(h)) return !isPrivateAddress(h);
  try {
    const resolved = await dns.promises.lookup(h, { all: true, verbatim: true });
    if (!resolved.length) return false;
    return resolved.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

/** http/https URL whose host is public (DNS-checked). For pre-flight outbound requests. */
export async function isSafeServerUrl(value: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return isPublicHost(parsed.hostname);
}

/**
 * Synchronous proxy-URL guard for the streaming hot path: scheme + hostname
 * checks only. Proxy exits come from the Webshare pool, which already
 * DNS-validated them at ingestion; this re-checks cheaply per stream.
 */
export function isSafeProxyUrlSync(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (looksLocalHostname(hostname)) return false;
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  return true;
}
