/**
 * JSON line logger — mirrors utils/logging_config.py (one JSON object per line).
 */
import type { Config } from './config.js';

type Level = 'debug' | 'info' | 'warning' | 'error';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warning: 30, error: 40 };

let minLevel = 20;
let enabled = !process.env.TESTING;

export function setupJsonLogging(cfg?: Config): void {
  if (cfg) enabled = !cfg.TESTING;
}

export function setLogLevel(level: Level): void {
  minLevel = LEVELS[level] ?? 20;
}

function emit(level: Level, logger: string, msg: string, extra?: Record<string, unknown>): void {
  if (!enabled || (LEVELS[level] ?? 20) < minLevel) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    logger,
    msg,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warning(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (m, e) => emit('debug', name, m, e),
    info: (m, e) => emit('info', name, m, e),
    warning: (m, e) => emit('warning', name, m, e),
    error: (m, e) => emit('error', name, m, e),
  };
}
