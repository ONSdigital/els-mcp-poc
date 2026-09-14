/**
 * Single HTTP client wrapper around the ELS API. Every tool goes through this module rather
 * than calling `fetch` directly — this is where the "absorb the sharp edges" design principle
 * (see docs/els-mcp-server-design.md) actually gets implemented, once:
 *
 * - base URL (ELS_API_BASE_URL)
 * - GSS-code upper-casing (the API is case-insensitive, but normalising here means no tool has
 *   to think about it)
 * - JSON parsing and a typed error for genuine failures (4xx/5xx)
 *
 * Distinguishing "no data" from "an error" is deliberately NOT this module's job for every
 * response shape, because the ELS API doesn't have one shape: a name search returns
 * `{data: []}` on zero matches (still 200), the data endpoint returns `{}` or per-indicator
 * empty arrays (still 200), and a genuinely bad area/indicator identifier is a real 404. A
 * single `{rows, isEmpty}` wrapper would lie about at least one of these. Instead this module
 * exposes small, explicit emptiness helpers that call sites use, so "is this actually empty"
 * stays a one-line, impossible-to-forget check without pretending every endpoint looks alike.
 */

import { ELS_API_BASE_URL } from "./config.js";

export class ElsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`ELS API error ${status} for ${path}: ${message}`);
    this.name = "ElsApiError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** GSS area codes are case-insensitive on every ELS endpoint; normalise to upper case so no
 * tool has to remember this quirk (see CLAUDE.md). Leaves non-area-code strings untouched. */
export function upperGss(code: string): string {
  return code.toUpperCase();
}

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(ELS_API_BASE_URL + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** GET a JSON path under ELS_API_BASE_URL. Throws ElsApiError on a non-2xx response (a
 * genuine failure, e.g. an unrecognised area code on /geo/lookup — confirmed 404 live, not a
 * 200-with-empty-body case). Callers decide what "empty but 200" means for their own endpoint
 * shape using the helpers below. */
export async function elsGet<T>(path: string, params?: QueryParams): Promise<T> {
  const url = buildUrl(path, params);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new ElsApiError(0, path, `network error: ${(cause as Error).message}`);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // body wasn't JSON (or was empty) — fall back to statusText, already set above.
    }
    throw new ElsApiError(res.status, path, message);
  }
  return (await res.json()) as T;
}

/** True when a `{data: [...]}`-shaped search/list response (e.g. /geo/search) matched
 * nothing. A 200 with an empty `data` array is "no matches," not an error. */
export function isEmptySearchResult(result: { data?: unknown[] }): boolean {
  return !result.data || result.data.length === 0;
}

/** True when a row array (e.g. one indicator's rows from /data.rows.json) is empty. The ELS
 * API returns 200 with an empty array (or omits the key entirely) for a request that resolves
 * but matches no observations — this is "no data," never an error. See CLAUDE.md / design doc. */
export function isEmptyRows(rows: unknown[] | undefined | null): boolean {
  return !rows || rows.length === 0;
}
