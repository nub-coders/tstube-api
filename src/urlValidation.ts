/**
 * Reject non-YouTube targets before they reach a yt-dlp subprocess (SSRF guard)
 * — port of utils/url_validation.py.
 *
 * yt-dlp's generic extractor will fetch ANY http(s) URL, so an unvalidated `q`
 * turns the stream routes into a "make my server fetch this" primitive.
 */

import { HttpError } from './httpError.js';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
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
    // `hostname` strips userinfo/port (like Python's urlparse), so
    // "evil.com@youtube.com" resolves to youtube.com — which is what gets fetched.
    return ALLOWED_HOSTS.has(parsed.hostname);
  }
  // file:, ftp:, etc. — never allowed.
  return false;
}

export class InvalidTargetError extends Error {
  readonly statusCode = 400;
  readonly detail = 'Invalid target: only YouTube URLs are allowed';
  constructor() {
    super('Invalid target: only YouTube URLs are allowed');
    this.name = 'InvalidTargetError';
  }
}

/** Return `value` if it's a YouTube URL / bare id, else raise a 400. */
export function validateYoutubeTarget(value: string): string {
  if (!isAllowedTarget(value)) {
    // FastAPI's HTTPException(400, detail=...) shape.
    throw new HttpError(400, { detail: 'Invalid target: only YouTube URLs are allowed' });
  }
  return value;
}
