/**
 * Route argument metadata and query validation — port of main.py's
 * `get_endpoint_args` / `get_arguments_for_request` / validation exception
 * handler, plus the parameter specs FastAPI validates.
 *
 * Argument tables are static (the signatures don't change) and preserve the
 * Python field order: {type, in, description?, default?}. The 401/422 bodies
 * embed them verbatim, so order and wording matter.
 */

export interface ArgInfo {
  type: string;
  in: string;
  description?: string;
  default?: unknown;
}

export interface ArgsTables {
  required_arguments: Record<string, ArgInfo>;
  optional_arguments: Record<string, ArgInfo>;
}

const AUTH_DESC = "API token (deprecated — prefer 'Authorization: Bearer <token>')";

export const ARGS: Record<string, ArgsTables> = {
  '/': { required_arguments: {}, optional_arguments: {} },
  '/health': { required_arguments: {}, optional_arguments: {} },
  '/metrics': { required_arguments: {}, optional_arguments: {} },
  '/favicon.ico': { required_arguments: {}, optional_arguments: {} },
  '/favicon.svg': { required_arguments: {}, optional_arguments: {} },
  '/search': {
    required_arguments: {
      q: { type: 'string', in: 'query', description: 'Search query' },
    },
    optional_arguments: {
      limit: { type: 'integer', in: 'query', description: 'Number of results', default: 5 },
      method: {
        type: 'string',
        in: 'query',
        description: "Search method: 'scrape' (free) or 'api' (uses YouTube Data API)",
        default: 'scrape',
      },
    },
  },
  '/trending': {
    required_arguments: {},
    optional_arguments: {
      limit: { type: 'integer', in: 'query', description: 'Number of trending songs', default: 10 },
    },
  },
  '/suggest': {
    required_arguments: {
      q: { type: 'string', in: 'query', description: 'Search query' },
    },
    optional_arguments: {
      limit: { type: 'integer', in: 'query', description: 'Number of suggestions', default: 5 },
    },
  },
  '/stream': {
    required_arguments: {
      q: { type: 'string', in: 'query', description: 'YouTube video URL' },
    },
    optional_arguments: {
      redirect: {
        type: 'boolean',
        in: 'query',
        description: 'Return a temporary redirect URL instead of the final stream URL',
        default: false,
      },
      mode: {
        type: 'string',
        in: 'query',
        description: "Stream mode: 'video' or 'audio'",
        default: 'video',
      },
      token: { type: 'string', in: 'query', description: AUTH_DESC, default: null },
    },
  },
  '/stream/redirect': {
    required_arguments: {
      q: { type: 'string', in: 'query', description: 'YouTube video URL' },
      token: { type: 'string', in: 'query', description: 'Your API token' },
    },
    optional_arguments: {
      mode: {
        type: 'string',
        in: 'query',
        description: "Stream mode: 'video' or 'audio'",
        default: 'video',
      },
    },
  },
  '/stream/resolver/{stream_id}': {
    required_arguments: { stream_id: { type: 'string', in: 'path' } },
    optional_arguments: {},
  },
  '/stream/proxy/{stream_id}': {
    required_arguments: { stream_id: { type: 'string', in: 'path' } },
    optional_arguments: {},
  },
  '/info': {
    required_arguments: {
      q: { type: 'string', in: 'query', description: 'YouTube video URL or search query' },
    },
    optional_arguments: {
      max_results: {
        type: 'integer',
        in: 'query',
        description: 'Max results for search queries',
        default: 1,
      },
      redirect: {
        type: 'boolean',
        in: 'query',
        description: 'Return a temporary redirect URL instead of waiting for the final stream',
        default: true,
      },
      token: { type: 'string', in: 'query', description: AUTH_DESC, default: null },
    },
  },
  '/playlist': {
    required_arguments: {
      url: {
        type: 'string',
        in: 'query',
        description: 'YouTube playlist URL or playlist ID (e.g. PLxxxxxxx, RDxxxxxx)',
      },
    },
    optional_arguments: {
      token: { type: 'string', in: 'query', description: AUTH_DESC, default: null },
    },
  },
  '/rate-limit-status': {
    required_arguments: {},
    optional_arguments: {
      token: { type: 'string', in: 'query', description: 'Your API token', default: null },
    },
  },
};

export function argsFor(path: string): ArgsTables {
  return ARGS[path] ?? { required_arguments: {}, optional_arguments: {} };
}

// ── Query validation ────────────────────────────────────────────

type ParamType = 'str' | 'int' | 'bool';

interface ParamSpec {
  name: string;
  typ: ParamType;
  required: boolean;
  ge?: number;
  le?: number;
  def?: unknown;
}

export type QueryValues = Record<string, string | number | boolean | null>;

export interface ValidationDetail {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

// Mirrors pydantic's int validator (probed against 2.12/2.13): optional sign,
// digits with single internal underscores, and an all-zeros decimal tail
// ("5.0" -> 5, "5." -> error).
const PYD_INT_RE = /^[+-]?[0-9]+(_[0-9]+)*(\.0+)?$/;

function parsePydanticInt(raw: string): number | null {
  let s = raw.trim();
  if (!PYD_INT_RE.test(s)) return null;
  s = s.replace(/_/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot);
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// pydantic bool: true/false/yes/no/on/off/1/0 plus y/n/t/f, case-insensitive.
function parsePydanticBool(raw: string): boolean | null {
  switch (raw.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
    case 'y':
    case 't':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
    case 'n':
    case 'f':
      return false;
    default:
      return null;
  }
}

function intDetail(type: string, name: string, input: string, bound?: number): ValidationDetail {
  const d: ValidationDetail = { type, loc: ['query', name], msg: '', input };
  switch (type) {
    case 'int_parsing':
      d.msg = 'Input should be a valid integer, unable to parse string as an integer';
      break;
    case 'greater_than_equal':
      d.msg = `Input should be greater than or equal to ${bound}`;
      d.ctx = { ge: bound };
      break;
    case 'less_than_equal':
      d.msg = `Input should be less than or equal to ${bound}`;
      d.ctx = { le: bound };
      break;
  }
  return d;
}

/**
 * Validate query params in signature order (that's the order 422 details come
 * back in). Returns parsed values plus any error details; empty details means
 * the request is valid.
 */
export function validateQuery(
  params: URLSearchParams,
  specs: ParamSpec[],
): { values: QueryValues; details: ValidationDetail[] } {
  const values: QueryValues = {};
  const details: ValidationDetail[] = [];
  for (const p of specs) {
    const vals = params.getAll(p.name);
    if (vals.length === 0) {
      if (p.required) {
        details.push({ type: 'missing', loc: ['query', p.name], msg: 'Field required', input: null });
      } else {
        values[p.name] = (p.def ?? null) as string | number | boolean | null;
      }
      continue;
    }
    // Starlette's QueryParams is a dict: repeated params, LAST occurrence wins.
    const v = vals[vals.length - 1]!;
    if (p.typ === 'str') {
      values[p.name] = v;
    } else if (p.typ === 'int') {
      const n = parsePydanticInt(v);
      if (n === null) details.push(intDetail('int_parsing', p.name, v));
      else if (p.ge !== undefined && n < p.ge)
        details.push(intDetail('greater_than_equal', p.name, v, p.ge));
      else if (p.le !== undefined && n > p.le)
        details.push(intDetail('less_than_equal', p.name, v, p.le));
      else values[p.name] = n;
    } else {
      const b = parsePydanticBool(v);
      if (b === null) {
        details.push({
          type: 'bool_parsing',
          loc: ['query', p.name],
          msg: 'Input should be a valid boolean, unable to interpret input',
          input: v,
        });
      } else {
        values[p.name] = b;
      }
    }
  }
  return { values, details };
}

// ── Per-route parameter specs ───────────────────────────────────

export const PARAMS: Record<string, ParamSpec[]> = {
  '/search': [
    { name: 'q', typ: 'str', required: true },
    { name: 'limit', typ: 'int', required: false, ge: 1, le: 20, def: 5 },
    { name: 'method', typ: 'str', required: false, def: 'scrape' },
  ],
  '/trending': [{ name: 'limit', typ: 'int', required: false, ge: 1, le: 20, def: 10 }],
  '/suggest': [
    { name: 'q', typ: 'str', required: true },
    { name: 'limit', typ: 'int', required: false, ge: 1, le: 20, def: 5 },
  ],
  '/stream': [
    { name: 'q', typ: 'str', required: true },
    { name: 'redirect', typ: 'bool', required: false, def: false },
    { name: 'mode', typ: 'str', required: false, def: 'video' },
    { name: 'token', typ: 'str', required: false, def: null },
  ],
  '/stream/redirect': [
    { name: 'q', typ: 'str', required: true },
    { name: 'mode', typ: 'str', required: false, def: 'video' },
    // Query-param only: header auth alone still 422s (FastAPI validates the Query).
    { name: 'token', typ: 'str', required: true },
  ],
  '/info': [
    { name: 'q', typ: 'str', required: true },
    { name: 'max_results', typ: 'int', required: false, ge: 1, le: 10, def: 1 },
    { name: 'redirect', typ: 'bool', required: false, def: true },
    { name: 'token', typ: 'str', required: false, def: null },
  ],
  '/playlist': [
    { name: 'url', typ: 'str', required: true },
    { name: 'token', typ: 'str', required: false, def: null },
  ],
  '/rate-limit-status': [{ name: 'token', typ: 'str', required: false, def: null }],
};

export function paramsFor(path: string): ParamSpec[] {
  return PARAMS[path] ?? [];
}
