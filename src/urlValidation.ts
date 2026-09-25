/**
 * Reject unsupported target URLs before they reach a yt-dlp subprocess (SSRF guard)
 * — port of utils/url_validation.py.
 *
 * Supports YouTube, Apple Music, Amazon Music, SoundCloud, JioSaavn, and Spotify hosts,
 * as well as bare search queries.
 */

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

export class InvalidTargetError extends Error {
  readonly statusCode = 400;
  readonly detail = 'Invalid target: only allowed streaming target URLs or search queries permitted';
  constructor() {
    super('Invalid target: only allowed streaming target URLs or search queries permitted');
    this.name = 'InvalidTargetError';
  }
}

/** Return `value` if it's an allowed target URL or search phrase, else raise a 400. */
export function validateTarget(value: string): string {
  if (!isAllowedTarget(value)) {
    throw new HttpError(400, { detail: 'Invalid target: only allowed streaming target URLs or search queries permitted' });
  }
  return value;
}

export const validateYoutubeTarget = validateTarget;
