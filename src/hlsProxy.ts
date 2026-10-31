/**
 * HLS playlists need a relay of their own: forwarding their text would send
 * players straight to signed, IP-bound segment URLs. Every child reference is
 * replaced with a Redis-backed bearer capability on the existing stream route.
 */
import { createHash, createDecipheriv } from 'node:crypto';
import { Readable } from 'node:stream';
import { redis } from './redis.js';
import { proxyStream, type ProxyOptions, type ProxyUpstream } from './streamProxy.js';
import { isPublicHost } from './urlValidation.js';

export const HLS_MANIFEST_MAX_BYTES = 1024 * 1024;
export const HLS_MANIFEST_MAX_CHILDREN = 1000;
export const HLS_RESOURCE_TTL_S = 300;
const HLS_SESSION_MAX_MS = 4 * 60 * 60_000;
const HLS_SESSION_DEFAULT_MS = 60 * 60_000;
const HLS_SAMPLE_BYTES = 16 * 1024;
const HLS_READ_TIMEOUT_MS = 15_000;
const HLS_MAX_HOSTS = 16;
const HLS_MAX_URL_LENGTH = 16 * 1024;
const HLS_MINT_CONCURRENCY = 8;
const TOKEN_PATTERN = /^hls_[A-Za-z0-9_-]{43}$/;

export interface HlsRequestOptions extends ProxyOptions {
  /** Render an opaque token as a local resolver/proxy URL. */
  childUrl: (token: string) => string;
}

export interface HlsManifestOptions extends HlsRequestOptions {
  /** Parent resolver capability: its random secret makes child tokens opaque. */
  scope: string;
  mode?: 'audio' | 'video';
  /** Fixed parent authority deadline in epoch milliseconds, capped at four hours. */
  expiresAt?: number;
  /** Carried from the selected master into its media playlist. */
  videoEvidence?: boolean;
}

interface HlsResource {
  url: string;
  kind: 'manifest' | 'segment';
  role: 'playlist' | 'audio' | 'segment' | 'part' | 'key' | 'map' | 'other';
  /** Video evidence from a normal variant's CODECS or RESOLUTION attributes. */
  video?: boolean;
  audio?: boolean;
  streamInfo?: string;
  mediaLine?: string;
  audioGroup?: string;
  group?: string;
  preferred?: boolean;
  sessionKey?: boolean;
  range?: ByteRange;
  key?: HlsKey;
  map?: HlsResource;
  sequence?: bigint;
}

interface ByteRange { offset: number; length: number }
interface HlsKey { url: string; method: string; iv?: string; format?: string }
interface MediaRendition { line: string; group: string; preferred: boolean; resource?: HlsResource }

interface StoredResource {
  url: string;
  kind: HlsResource['kind'];
  proxyUrl: string | null;
  scope: string;
  mode: 'audio' | 'video';
  expiresAt: number;
  sessionKey?: boolean;
  range?: ByteRange;
  videoEvidence?: boolean;
}

interface ManifestReference {
  start: number;
  end: number;
  resource: HlsResource;
}

interface ParsedManifest {
  text: string;
  references: ManifestReference[];
  base: string;
  audioRenditions: MediaRendition[];
}

interface LoadedManifest {
  upstream: ProxyUpstream;
  parsed?: ParsedManifest;
}

function errorResult(status = 502, message = 'Invalid HLS stream source'): ProxyUpstream {
  return { status, headers: { 'content-type': 'application/json' }, body: null, error: { error: message } };
}

function cancelled(signal?: AbortSignal): ProxyUpstream {
  return signal?.aborted ? errorResult(499, 'Client Closed Request') : errorResult(502, 'HLS source timed out');
}

/** Cancellation must also interrupt waits for DNS and shared Redis commands. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Cancelled HLS request')); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

function resolvedUrl(reference: string, base: string): string {
  if (!reference || reference.length > HLS_MAX_URL_LENGTH || reference.includes('{$')) throw new Error('Unsupported HLS URI');
  const url = new URL(reference, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported HLS URI');
  // Fragments do not participate in HTTP requests or signed CDN identities.
  url.hash = '';
  if (url.href.length > HLS_MAX_URL_LENGTH) throw new Error('Oversized HLS URI');
  return url.href;
}

function attributeRole(tag: string, attributes: HlsAttribute[]): Pick<HlsResource, 'kind' | 'role'> {
  if (['EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-IMAGE-STREAM-INF', 'EXT-X-RENDITION-REPORT'].includes(tag)) {
    return { kind: 'manifest', role: tag === 'EXT-X-MEDIA' && attributes.find(attribute => attribute.name === 'TYPE')?.value === 'AUDIO' ? 'audio' : 'playlist' };
  }
  const role = ['EXT-X-KEY', 'EXT-X-SESSION-KEY'].includes(tag) ? 'key'
    : tag === 'EXT-X-MAP' ? 'map'
      : tag === 'EXT-X-PART' ? 'part' : 'other';
  return { kind: 'segment', role };
}

interface HlsAttribute { name: string; value: string; quoted: boolean; start: number; end: number }

/** Parse attribute boundaries without treating commas inside quotes as fields. */
function parseAttributes(raw: string): HlsAttribute[] {
  const attributes: HlsAttribute[] = [];
  let cursor = raw.indexOf(':') + 1;
  if (cursor <= 0) return attributes;
  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    const name = /^[A-Z0-9-]+/.exec(raw.slice(cursor))?.[0];
    if (!name) throw new Error('Malformed HLS attributes');
    cursor += name.length;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (raw[cursor++] !== '=') throw new Error('Malformed HLS attributes');
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    const quoted = raw[cursor] === '"';
    if (quoted) cursor++;
    const start = cursor;
    if (quoted) {
      const close = raw.indexOf('"', cursor);
      if (close < 0) throw new Error('Malformed HLS attributes');
      cursor = close;
    } else {
      while (cursor < raw.length && raw[cursor] !== ',') cursor++;
      while (cursor > start && /\s/.test(raw[cursor - 1])) cursor--;
    }
    const end = cursor;
    const value = raw.slice(start, end);
    if (!value || (!quoted && /\s/.test(value))) throw new Error('Malformed HLS attributes');
    attributes.push({ name, value, quoted, start, end });
    if (quoted) cursor++;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (cursor === raw.length) break;
    if (raw[cursor++] !== ',' || cursor === raw.length) throw new Error('Malformed HLS attributes');
  }
  return attributes;
}

function attributeValue(attributes: HlsAttribute[], name: string): string | undefined {
  return attributes.find(attribute => attribute.name === name)?.value;
}

function byteRange(value: string, url: string, previous?: { url: string; range: ByteRange }): ByteRange {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid HLS byte range');
  const length = Number(match[1]);
  const offset = match[2] === undefined ? previous?.url === url ? previous.range.offset + previous.range.length : NaN : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error('Invalid HLS byte range');
  return { offset, length };
}

const ATTRIBUTE_TAGS = new Set([
  'EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-IMAGE-STREAM-INF', 'EXT-X-RENDITION-REPORT',
  'EXT-X-KEY', 'EXT-X-SESSION-KEY', 'EXT-X-MAP', 'EXT-X-PART', 'EXT-X-PRELOAD-HINT',
  'EXT-X-SESSION-DATA', 'EXT-X-STREAM-INF', 'EXT-X-DATERANGE',
]);

/** Build the complete replacement plan before issuing any child capabilities. */
function parseManifest(text: string, base: string): ParsedManifest {
  text = text.replace(/^\uFEFF/, '');
  if (text.split(/\r?\n/, 1)[0]?.trim() !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const references: ManifestReference[] = [];
  const audioRenditions: MediaRendition[] = [];
  let offset = 0;
  let expectsPlaylist: { video: boolean; audio: boolean; audioGroup?: string; streamInfo: string } | null = null;
  let expectsSegment = false;
  let targetDuration = false;
  let sequence = 0n;
  let key: HlsKey | undefined;
  let map: HlsResource | undefined;
  let rangeText: string | undefined;
  let previousRange: { url: string; range: ByteRange } | undefined;
  let previousPartRange: { url: string; range: ByteRange } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) {
      if (!expectsPlaylist && !expectsSegment) throw new Error('Unexpected HLS media URI');
      const start = offset + raw.indexOf(line);
      const resource: HlsResource = { url: resolvedUrl(line, base), kind: expectsPlaylist ? 'manifest' : 'segment', role: expectsPlaylist ? 'playlist' : 'segment',
        ...(expectsPlaylist ?? { key, map, sequence }) };
      if (!expectsPlaylist) {
        if (rangeText) { resource.range = byteRange(rangeText, resource.url, previousRange); previousRange = { url: resource.url, range: resource.range }; }
        else previousRange = undefined;
        rangeText = undefined;
        sequence++;
      }
      references.push({ start, end: start + line.length, resource });
      expectsPlaylist = null;
      expectsSegment = false;
    } else if (line.startsWith('#EXT')) {
      const tag = /^#([^:]+)/.exec(line)?.[1] ?? '';
      if (tag === 'EXT-X-TARGETDURATION') targetDuration = /^#EXT-X-TARGETDURATION:\s*[1-9]\d*\s*$/.test(line);
      if (tag === 'EXTINF') expectsSegment = /^#EXTINF:\s*\d+(?:\.\d+)?\s*,/.test(line);
      if (tag === 'EXT-X-MEDIA-SEQUENCE') {
        const value = line.slice(line.indexOf(':') + 1).trim();
        if (!/^\d+$/.test(value)) throw new Error('Invalid HLS media sequence');
        sequence = BigInt(value);
      }
      if (tag === 'EXT-X-BYTERANGE') rangeText = line.slice(line.indexOf(':') + 1).trim();
      // Variable definitions and content-steering JSON can hide fetch URLs in
      // different fields. They require their own protocol relay; never expose
      // those upstream instructions unchanged.
      if (['EXT-X-DEFINE', 'EXT-X-CONTENT-STEERING', 'EXT-X-PREFETCH', 'EXT-X-PREFETCH-DISCONTINUITY'].includes(tag)) throw new Error('Unsupported HLS fetch instruction');
      const attributes = ATTRIBUTE_TAGS.has(tag) ? parseAttributes(raw) : [];
      if (attributes.some(attribute => attribute.name !== 'URI' && /(?:URI|ASSET-LIST)$/.test(attribute.name))) throw new Error('Unsupported HLS fetch instruction');
      if (tag === 'EXT-X-STREAM-INF') {
        const codecs = attributeValue(attributes, 'CODECS') ?? '';
        if (attributeValue(attributes, 'VIDEO')) throw new Error('Unsupported external video rendition');
        expectsPlaylist = { video: /^\d+x\d+$/.test(attributeValue(attributes, 'RESOLUTION') ?? '') ||
          /(?:^|,)\s*(?:avc[134]|hvc[12]|hev[12]|vp0[89]|av01|dvh[1e]|dvav)(?:\.|,|$)/i.test(codecs),
        audio: /(?:^|,)\s*(?:mp4a|opus|ac-3|ec-3|flac)(?:\.|,|$)/i.test(codecs), audioGroup: attributeValue(attributes, 'AUDIO'), streamInfo: line };
      }
      if (tag === 'EXT-X-KEY') {
        const method = attributeValue(attributes, 'METHOD');
        const uri = attributeValue(attributes, 'URI');
        if (method === 'NONE') key = undefined;
        else if (!method || !uri) throw new Error('Invalid HLS encryption key');
        else key = { method, url: resolvedUrl(uri, base), iv: attributeValue(attributes, 'IV'), format: attributeValue(attributes, 'KEYFORMAT') };
      }
      let audioRendition: MediaRendition | undefined;
      if (tag === 'EXT-X-MEDIA' && attributeValue(attributes, 'TYPE') === 'AUDIO') {
        const group = attributeValue(attributes, 'GROUP-ID');
        if (!group) throw new Error('Invalid HLS audio group');
        audioRendition = { line, group, preferred: attributeValue(attributes, 'DEFAULT') === 'YES' };
        audioRenditions.push(audioRendition);
      }
      for (const attribute of attributes.filter(attribute => attribute.name === 'URI')) {
        if (!attribute.quoted) throw new Error('Malformed HLS URI attribute');
        const resource: HlsResource = { url: resolvedUrl(attribute.value, base), ...attributeRole(tag, attributes),
          ...(tag === 'EXT-X-SESSION-KEY' ? { sessionKey: true } : {}) };
        if (tag === 'EXT-X-SESSION-KEY') {
          const method = attributeValue(attributes, 'METHOD');
          const format = attributeValue(attributes, 'KEYFORMAT');
          if (method !== 'AES-128' || format && format !== 'identity') throw new Error('Unsupported HLS session key');
        }
        if (tag === 'EXT-X-MAP' || tag === 'EXT-X-PART') {
          const range = attributeValue(attributes, 'BYTERANGE');
          if (range) resource.range = byteRange(tag === 'EXT-X-MAP' && !range.includes('@') ? `${range}@0` : range,
            resource.url, previousPartRange);
          if (tag === 'EXT-X-PART') previousPartRange = resource.range ? { url: resource.url, range: resource.range } : undefined;
          resource.key = key;
          resource.map = tag === 'EXT-X-PART' ? map : undefined;
          resource.sequence = sequence;
          if (tag === 'EXT-X-MAP') map = resource;
        }
        if (audioRendition) { resource.mediaLine = line; resource.group = audioRendition.group; resource.preferred = audioRendition.preferred; audioRendition.resource = resource; }
        references.push({ start: offset + attribute.start, end: offset + attribute.end, resource });
      }
      if (!ATTRIBUTE_TAGS.has(tag) && /(?:^|[:,])\s*[A-Z0-9-]*(?:URI|ASSET-LIST)\s*=/.test(raw)) throw new Error('Unsupported HLS fetch instruction');
    }
    if (references.length > HLS_MANIFEST_MAX_CHILDREN) throw new Error('Too many HLS references');
    offset += raw.length + 1;
  }
  if (expectsPlaylist || expectsSegment || !references.length ||
      (references.some(ref => ['segment', 'part'].includes(ref.resource.role)) && !targetDuration)) throw new Error('Incomplete HLS playlist');
  return { text, references, base, audioRenditions };
}

async function validateReferenceHosts(parsed: ParsedManifest, signal?: AbortSignal): Promise<void> {
  const hosts = [...new Set(parsed.references.map(({ resource }) => new URL(resource.url).hostname))];
  if (hosts.length > HLS_MAX_HOSTS) throw new Error('Too many HLS origins');
  const permitted = await abortable(Promise.all(hosts.map(host => isPublicHost(host))), signal);
  if (signal?.aborted || permitted.some(ok => !ok)) throw new Error('Unsafe HLS origin');
}

async function readManifest(body: Readable, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const encoding = headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') throw new Error('Encoded HLS playlist');
  const length = headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > HLS_MANIFEST_MAX_BYTES)) throw new Error('Oversized HLS playlist');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw new Error('Cancelled HLS playlist');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > HLS_MANIFEST_MAX_BYTES) throw new Error('Oversized HLS playlist');
    chunks.push(bytes);
  }
  if (signal.aborted || (length !== undefined && total !== Number(length))) throw new Error('Incomplete HLS playlist');
  return Buffer.concat(chunks, total).toString('utf8');
}

async function loadManifest(target: string, options: ProxyOptions): Promise<LoadedManifest> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(HLS_READ_TIMEOUT_MS)]) : AbortSignal.timeout(HLS_READ_TIMEOUT_MS);
  let body: Readable | null = null;
  try {
    const upstream = await proxyStream(target, { ...options, rangeHeader: null, signal });
    body = upstream.body;
    if (signal.aborted) return { upstream: cancelled(options.signal) };
    if (upstream.status >= 400 || !body) return { upstream };
    if (upstream.status !== 200) return { upstream: errorResult() };
    const text = await readManifest(body, upstream.headers, signal);
    const parsed = parseManifest(text, upstream.finalUrl ?? target);
    await validateReferenceHosts(parsed, signal);
    return { upstream, parsed };
  } catch {
    return { upstream: signal.aborted ? cancelled(options.signal) : errorResult() };
  } finally {
    body?.destroy();
  }
}

interface MasterSelection { primary: HlsResource; audio?: MediaRendition; filtered: ParsedManifest }

function masterGlobals(parsed: ParsedManifest): string[] {
  return parsed.text.split(/\r?\n/).filter(line =>
    /^#EXTM3U\s*$/.test(line) || /^#EXT-X-(?:VERSION|INDEPENDENT-SEGMENTS|START|SESSION-KEY|SESSION-DATA):?/.test(line))
    .map(line => {
      let output = line;
      const tag = /^#([^:]+)/.exec(line)?.[1] ?? '';
      for (const attribute of (ATTRIBUTE_TAGS.has(tag) ? parseAttributes(line) : []).filter(attribute => attribute.name === 'URI').reverse()) {
        output = output.slice(0, attribute.start) + resolvedUrl(attribute.value, parsed.base) + output.slice(attribute.end);
      }
      return output;
    });
}

/** Probe and relay make the same deterministic choice, exposing only that track. */
function selectMaster(parsed: ParsedManifest, mode: 'audio' | 'video'): MasterSelection | null {
  const variants = parsed.references.map(ref => ref.resource).filter(resource => resource.streamInfo);
  if (!variants.length && !parsed.audioRenditions.length) return null;
  const preferred = (renditions: MediaRendition[]) => renditions.find(rendition => rendition.preferred) ?? renditions[0];
  if (mode === 'audio') {
    const rendition = preferred(parsed.audioRenditions.filter(rendition => rendition.resource));
    const primary = rendition?.resource ?? variants.find(resource => resource.audio && !resource.video)
      ?? variants.find(resource => resource.audio && !resource.audioGroup);
    if (!primary) throw new Error('No HLS audio rendition');
    const text = [...masterGlobals(parsed), ...(rendition ? [rendition.line] : [primary.streamInfo!, primary.url]), ''].join('\n');
    return { primary, filtered: parseManifest(text, parsed.base) };
  }
  const primary = variants.find(resource => resource.video);
  if (!primary) throw new Error('No video HLS variant');
  const audio = primary.audioGroup ? preferred(parsed.audioRenditions.filter(rendition => rendition.group === primary.audioGroup)) : undefined;
  if (primary.audioGroup && !audio) throw new Error('Missing HLS audio group');
  if (!audio?.resource && !primary.audio) throw new Error('Video variant has no audio evidence');
  const globals = masterGlobals(parsed);
  // Optional unverified subtitle/caption groups and trick-play variants cannot
  // issue escape capabilities from an otherwise validated master.
  const streamInfo = '#EXT-X-STREAM-INF:' + parseAttributes(primary.streamInfo!).filter(attribute => !['SUBTITLES', 'CLOSED-CAPTIONS'].includes(attribute.name))
    .map(attribute => `${attribute.name}=${attribute.quoted ? `"${attribute.value}"` : attribute.value}`).join(',');
  const text = [...globals, ...(audio ? [audio.line] : []), streamInfo, primary.url, ''].join('\n');
  return { primary, audio, filtered: parseManifest(text, parsed.base) };
}

function filterMedia(parsed: ParsedManifest): ParsedManifest {
  // Rendition reports can otherwise mint routes to tracks omitted by the master.
  const text = parsed.text.split('\n').filter(line => !line.trim().startsWith('#EXT-X-RENDITION-REPORT:')).join('\n');
  return text === parsed.text ? parsed : parseManifest(text, parsed.base);
}

interface HlsSample { bytes: Buffer; complete: boolean; mime?: string }

function readPrefix(body: Readable, limit: number, signal?: AbortSignal): Promise<HlsSample | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (ok: boolean, complete = false) => {
      if (done) return;
      done = true;
      body.off('data', data).off('end', end).off('error', fail).off('close', fail);
      signal?.removeEventListener('abort', fail);
      body.destroy();
      resolve(ok && length ? { bytes: Buffer.concat(chunks, length), complete } : null);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const part = bytes.subarray(0, limit - length);
      chunks.push(part); length += part.length;
      if (length === limit) finish(true);
    };
    const end = () => finish(true, true);
    const fail = () => finish(false);
    if (signal?.aborted || body.destroyed) { finish(false); return; }
    body.on('data', data).once('end', end).once('error', fail).once('close', fail);
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** Match playback GET/advertised range, while retaining only a bounded prefix. */
async function fetchSample(resource: Pick<HlsResource, 'url' | 'range'>, options: ProxyOptions, limit = HLS_SAMPLE_BYTES): Promise<HlsSample | null> {
  let body: Readable | null = null;
  try {
    if (options.signal?.aborted) return null;
    const range = resource.range;
    const response = await proxyStream(resource.url, { ...options, rangeHeader: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : null });
    body = response.body;
    if (!body || response.error || options.signal?.aborted || (range ? response.status !== 206 : response.status !== 200)) return null;
    const encoding = response.headers['content-encoding']?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') return null;
    let expected: number | undefined;
    if (range) {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers['content-range'] ?? '');
      if (!match || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.length - 1 ||
          (match[3] !== '*' && Number(match[3]) < range.offset + range.length)) return null;
      expected = range.length;
    }
    const contentLength = response.headers['content-length'];
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) <= 0 ||
          (expected !== undefined && expected !== Number(contentLength))) return null;
      expected = Number(contentLength);
    }
    const sample = await readPrefix(body, Math.min(limit, expected ?? limit), options.signal);
    if (!sample || options.signal?.aborted || (expected !== undefined && sample.bytes.length !== Math.min(limit, expected))) return null;
    const mime = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mime && /(?:mpegurl|html|json)/.test(mime) || /^\s*#EXTM3U/.test(sample.bytes.toString('utf8', 0, 32))) return null;
    return { bytes: sample.bytes, complete: sample.complete || expected !== undefined && expected <= limit, mime };
  } catch { return null; }
  finally { body?.destroy(); }
}

function ivFor(key: HlsKey, sequence?: bigint): Buffer | null {
  if (key.iv) {
    if (!/^0x[0-9a-f]{1,32}$/i.test(key.iv)) return null;
    return Buffer.from(key.iv.slice(2).padStart(32, '0'), 'hex');
  }
  if (sequence === undefined || sequence < 0n || sequence >= 1n << 128n) return null;
  return Buffer.from(sequence.toString(16).padStart(32, '0'), 'hex');
}

async function decodeSample(resource: HlsResource, sample: HlsSample, options: ProxyOptions, keys: Map<string, Buffer>): Promise<Buffer | null> {
  if (!resource.key) return sample.bytes;
  const key = resource.key;
  if (key.method !== 'AES-128' || key.format && key.format !== 'identity') return null;
  let bytes = keys.get(key.url);
  if (!bytes) {
    const fetched = await fetchSample({ url: key.url }, options, 17);
    if (!fetched?.complete || fetched.bytes.length !== 16) return null;
    bytes = fetched.bytes; keys.set(key.url, bytes);
  }
  const iv = ivFor(key, resource.role === 'map' ? undefined : resource.sequence);
  if (!iv || sample.bytes.length < 16 || sample.complete && sample.bytes.length % 16) return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', bytes, iv);
    decipher.setAutoPadding(sample.complete);
    const ciphertext = sample.bytes.subarray(0, sample.bytes.length - sample.bytes.length % 16);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { return null; }
}

function boxes(bytes: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8) break;
    types.push(bytes.toString('ascii', offset + 4, offset + 8));
    if (size > bytes.length - offset) break;
    offset += size;
  }
  return types;
}

function isInit(bytes: Buffer): boolean {
  const types = boxes(bytes);
  return types.includes('ftyp') && types.includes('moov');
}

function isSegment(bytes: Buffer, hasMap: boolean): boolean {
  if (bytes.length < 12 || /^\s*(?:#EXTM3U|<|\{|\[)/.test(bytes.toString('utf8', 0, 32))) return false;
  if (bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47) return true;
  if (hasMap && boxes(bytes).includes('moof')) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0 && ((bytes[2] >> 2) & 0x0f) < 13) return true; // ADTS AAC
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 8 && (bytes[1] & 6) !== 0 &&
      (bytes[2] & 0xf0) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 12) !== 12) return true;
  return false;
}

async function verifyLeaf(parsed: ParsedManifest, options: ProxyOptions, mode: 'audio' | 'video', videoEvidence: boolean): Promise<boolean> {
  const latest = parsed.references.map(ref => ref.resource).filter(resource => resource.role === 'segment' || resource.role === 'part').at(-1);
  if (!latest) return false;
  const keys = new Map<string, Buffer>();
  if (latest.map) {
    const sample = await fetchSample(latest.map, options);
    if (!sample) return false;
    const decoded = await decodeSample(latest.map, sample, options, keys);
    if (!decoded || !isInit(decoded)) return false;
  }
  const sample = await fetchSample(latest, options);
  if (!sample) return false;
  const decoded = await decodeSample(latest, sample, options, keys);
  if (!decoded || !isSegment(decoded, !!latest.map)) return false;
  if (mode === 'video') {
    const videoContainer = decoded.length >= 376 && decoded[0] === 0x47 && decoded[188] === 0x47 ||
      !!latest.map && boxes(decoded).includes('moof');
    if (!videoContainer || sample.mime?.startsWith('audio/') || !videoEvidence && !sample.mime?.startsWith('video/')) return false;
  }
  return true;
}

async function verifySessionKeys(parsed: ParsedManifest, options: ProxyOptions): Promise<boolean> {
  for (const resource of parsed.references.map(ref => ref.resource).filter(resource => resource.sessionKey)) {
    const sample = await fetchSample(resource, options, 17);
    if (!sample?.complete || sample.bytes.length !== 16) return false;
  }
  return true;
}

async function verifyTrack(target: string, mode: 'audio' | 'video', options: ProxyOptions, depth = 0, videoEvidence = false, initial?: ParsedManifest): Promise<ParsedManifest | null> {
  if (depth >= 3 || options.signal?.aborted) return null;
  const parsed = initial ?? (await loadManifest(target, options)).parsed;
  if (!parsed) return null;
  const selection = selectMaster(parsed, mode);
  if (!selection) return await verifyLeaf(parsed, options, mode, videoEvidence) ? filterMedia(parsed) : null;
  if (!await verifySessionKeys(selection.filtered, options)) return null;
  const primary = await verifyTrack(selection.primary.url, mode, options, depth + 1, videoEvidence || !!selection.primary.video);
  if (!primary) return null;
  if (selection.audio?.resource && !await verifyTrack(selection.audio.resource.url, 'audio', options, depth + 1)) return null;
  if (mode === 'audio') {
    // A leaf audio playlist works directly in players; a master containing only
    // EXT-X-MEDIA has no normal variant for them to start. Keep its session keys.
    const sessionKeys = masterGlobals(selection.filtered).filter(line => line.startsWith('#EXT-X-SESSION-KEY:'));
    return sessionKeys.length ? parseManifest(primary.text.replace('#EXTM3U', ['#EXTM3U', ...sessionKeys].join('\n')), primary.base) : primary;
  }
  return selection.filtered;
}

function resourceKey(token: string): string { return `hls_resource:${token}`; }

function resourceToken(resource: HlsResource, options: HlsManifestOptions): string {
  return `hls_${createHash('sha256').update(JSON.stringify([options.scope, resource.url, options.proxyUrl ?? null,
    resource.kind, options.mode ?? 'video', options.expiresAt])).digest('base64url')}`;
}

function resourceTtl(expiresAt: number, kind: HlsResource['kind'] = 'segment', sessionKey = false): number {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(kind === 'manifest' || sessionKey ? HLS_SESSION_MAX_MS / 1000 : HLS_RESOURCE_TTL_S, Math.ceil(remaining / 1000)));
}

async function rewriteManifest(parsed: ParsedManifest, options: HlsManifestOptions): Promise<string> {
  const expiresAt = options.expiresAt!;
  const ttl = resourceTtl(expiresAt);
  if (!options.scope || !Number.isFinite(expiresAt) || ttl <= 0) throw new Error('Expired HLS authority');
  const resources = new Map<string, HlsResource>();
  for (const { resource } of parsed.references) resources.set(resourceToken(resource, options), resource);
  const entries = [...resources];
  let index = 0;
  const mintController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, mintController.signal]) : mintController.signal;
  try {
    await Promise.all(Array.from({ length: Math.min(HLS_MINT_CONCURRENCY, entries.length) }, async () => {
      while (index < entries.length) {
        if (signal.aborted) throw new Error('Cancelled HLS playlist');
        const [token, resource] = entries[index++];
        const stored: StoredResource = { url: resource.url, kind: resource.kind, proxyUrl: options.proxyUrl ?? null,
          scope: options.scope, mode: resource.role === 'audio' ? 'audio' : options.mode ?? 'video', expiresAt,
          sessionKey: resource.sessionKey, range: resource.range,
          videoEvidence: resource.role !== 'audio' && (!!options.videoEvidence || !!resource.video) };
        const ttl = resourceTtl(expiresAt, resource.kind, resource.sessionKey);
        if (!ttl) throw new Error('Expired HLS authority');
        await abortable(redis().set(resourceKey(token), JSON.stringify(stored), 'EX', ttl), signal);
      }
    }));
  } finally {
    mintController.abort();
  }
  if (options.signal?.aborted) throw new Error('Cancelled HLS playlist');
  let output = '';
  let cursor = 0;
  for (const ref of parsed.references) {
    output += parsed.text.slice(cursor, ref.start) + options.childUrl(resourceToken(ref.resource, options));
    cursor = ref.end;
  }
  return output + parsed.text.slice(cursor);
}

/** Fetch and rewrite a root or child playlist; never return raw text on error. */
export async function proxyHlsManifest(target: string, options: HlsManifestOptions): Promise<ProxyUpstream> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(HLS_READ_TIMEOUT_MS)]) : AbortSignal.timeout(HLS_READ_TIMEOUT_MS);
  try {
    const expiresAt = Math.min(options.expiresAt ?? Date.now() + (options.proxyUrl ? HLS_SESSION_DEFAULT_MS : HLS_SESSION_MAX_MS), Date.now() + HLS_SESSION_MAX_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return errorResult(502, 'Expired HLS authority');
    const loaded = await loadManifest(target, { ...options, signal });
    if (!loaded.parsed) return loaded.upstream.status === 499 && !options.signal?.aborted ? cancelled() : loaded.upstream;
    const parsed = await verifyTrack(target, options.mode ?? 'video', { ...options, signal }, 0, !!options.videoEvidence, loaded.parsed);
    if (!parsed) return signal.aborted ? cancelled(options.signal) : errorResult();
    const text = await rewriteManifest(parsed, { ...options, expiresAt, signal });
    return { status: 200, headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(text)),
    }, body: Readable.from([text]) };
  } catch {
    return signal.aborted ? cancelled(options.signal) : errorResult(502, 'Unable to relay HLS playlist');
  }
}

/** Lookup only previously issued capabilities; requests never supply a URL. */
export async function resolveHlsResource(token: string, options: HlsRequestOptions): Promise<ProxyUpstream | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  if (options.signal?.aborted) return cancelled(options.signal);
  let resource: StoredResource;
  try {
    const raw = await abortable(redis().get(resourceKey(token)), options.signal);
    if (!raw) return null;
    resource = JSON.parse(raw) as StoredResource;
    if (typeof resource.url !== 'string' || typeof resource.scope !== 'string' || !resource.scope ||
        !['manifest', 'segment'].includes(resource.kind) || !['audio', 'video'].includes(resource.mode) ||
        (resource.proxyUrl !== null && typeof resource.proxyUrl !== 'string') ||
        !Number.isFinite(resource.expiresAt) || resourceTtl(resource.expiresAt, resource.kind, resource.sessionKey) <= 0) return null;
  } catch {
    return options.signal?.aborted ? cancelled(options.signal) : errorResult(502, 'Unable to resolve HLS resource');
  }
  const pinned = { ...options, proxyUrl: resource.proxyUrl,
    rangeHeader: options.rangeHeader ?? (resource.range ? `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}` : null) };
  if (resource.kind === 'manifest') return proxyHlsManifest(resource.url, {
    ...pinned, scope: resource.scope, mode: resource.mode, expiresAt: resource.expiresAt, videoEvidence: resource.videoEvidence,
  });
  return proxyStream(resource.url, pinned);
}

/** Check playlists and a real media segment through the same extraction exit. */
export async function probeHls(target: string, options: ProxyOptions & { mode?: 'audio' | 'video'; deadline?: number } = {}): Promise<boolean> {
  const timeout = Math.min(HLS_READ_TIMEOUT_MS, (options.deadline ?? Infinity) - Date.now());
  if (options.signal?.aborted || timeout <= 0) return false;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  try { return !!await verifyTrack(target, options.mode ?? 'audio', { ...options, signal }); }
  catch { return false; }
}
