import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-to-server auth: koala-bar (or any client) sends the shared key as
 * "Authorization: Bearer <STOCK_API_KEY>" or "x-api-key: <STOCK_API_KEY>".
 * Vercel Cron invocations are authorized via CRON_SECRET instead.
 */
function isAuthorized(req: NextRequest): boolean {
  const apiKey = process.env.STOCK_API_KEY;
  const cronSecret = process.env.CRON_SECRET;
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const headerKey = req.headers.get('x-api-key');
  if (apiKey && (bearer === apiKey || headerKey === apiKey)) return true;
  if (cronSecret && bearer === cronSecret) return true;
  return false;
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin');
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (req: NextRequest, params: Record<string, string>) => Promise<NextResponse | object>;

/**
 * Wraps a route handler with auth, CORS and uniform error handling.
 * Handlers may return a plain object (serialized as JSON) or a NextResponse.
 */
export function withApi(handler: Handler) {
  return async (
    req: NextRequest,
    ctx: { params: Promise<Record<string, string>> }
  ): Promise<NextResponse> => {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: cors });
    }
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: cors });
    }
    try {
      const params = ctx?.params ? await ctx.params : {};
      const result = await handler(req, params);
      if (result instanceof NextResponse) {
        for (const [k, v] of Object.entries(cors)) result.headers.set(k, v);
        return result;
      }
      return NextResponse.json(result, { headers: cors });
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
      }
      console.error('API error:', err);
      const message = err instanceof Error ? err.message : 'internal error';
      return NextResponse.json({ error: message }, { status: 500, headers: cors });
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, 'invalid JSON body');
  }
}

export function requireNumber(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ApiError(400, `"${field}" must be a number`);
  }
  return n;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, `"${field}" is required`);
  }
  return value.trim();
}

/** YYYY-MM-DD in Europe/Lisbon (the bar's timezone), offset by `daysAgo`. */
export function lisbonDate(daysAgo = 0): string {
  const now = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return now.toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Weekdays the business is closed (0=Sunday … 6=Saturday). Defaults to
 * Monday; override with CLOSED_WEEKDAYS, e.g. "1" or "0,1".
 */
export function closedWeekdays(): number[] {
  const raw = process.env.CLOSED_WEEKDAYS ?? '1';
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function isClosedDay(isoDate: string): boolean {
  const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return closedWeekdays().includes(weekday);
}
