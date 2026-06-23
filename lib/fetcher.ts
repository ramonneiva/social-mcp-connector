/**
 * Small fetch helper with a timeout and robust JSON / API-error handling.
 *
 * It NEVER throws on an HTTP or network error — it always resolves to a
 * `FetchResult` so callers (the MCP tools) can surface a clean message instead
 * of crashing the server.
 */

export interface FetchResult<T = any> {
  ok: boolean;
  status: number;
  /** Parsed JSON body (present on success and, when available, on error). */
  data?: T;
  /** Human-readable error message, set when `ok` is false. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchJson<T = any>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const raw = await res.text();

    let json: any = undefined;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = { raw };
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: json,
        error: extractApiError(json) ?? `HTTP ${res.status} ${res.statusText}`.trim(),
      };
    }

    // Some APIs (TikTok) return HTTP 200 with an embedded error object.
    const embedded = extractApiError(json);
    if (embedded) {
      return { ok: false, status: res.status, data: json, error: embedded };
    }

    return { ok: true, status: res.status, data: json as T };
  } catch (e: any) {
    const message =
      e?.name === 'AbortError'
        ? `Request timed out after ${timeoutMs}ms`
        : e?.message || String(e);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalises error shapes from Meta Graph API and TikTok Display API into a
 * single readable string. Returns `undefined` when the payload represents
 * success (so it is safe to call on every response).
 */
export function extractApiError(json: any): string | undefined {
  if (!json || typeof json !== 'object') return undefined;

  // Meta Graph API: { error: { message, type, code, error_subcode, fbtrace_id } }
  if (json.error && typeof json.error === 'object' && typeof json.error.message === 'string') {
    const e = json.error;
    // TikTok also nests under `error` but uses code "ok" for success.
    if (typeof e.code === 'string' && e.code !== 'ok') {
      return `TikTok API error: ${e.message || e.code} [code=${e.code}${
        e.log_id ? `, log_id=${e.log_id}` : ''
      }]`;
    }
    if (typeof e.code === 'string' && e.code === 'ok') {
      return undefined; // TikTok success
    }
    // Meta-style numeric code (or no code)
    const parts: string[] = [e.message];
    if (e.code != null) {
      parts.push(`code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}`);
    }
    if (e.fbtrace_id) parts.push(`fbtrace ${e.fbtrace_id}`);
    return `Meta API error: ${parts.join(' — ')}`;
  }

  // TikTok success path where error.code === "ok" handled above; nothing to report.
  return undefined;
}
