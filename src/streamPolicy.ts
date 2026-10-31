/** Bump when previously cached streams have not passed the current playback checks. */
export const STREAM_VALIDATION_VERSION = 1;

/** Live manifests can rotate before their signed URL expires, or omit expiry entirely. */
export const HLS_STREAM_TTL_S = 60;
