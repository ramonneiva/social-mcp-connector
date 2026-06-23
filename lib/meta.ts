/**
 * Meta Graph API helpers (Facebook Pages + Instagram Business accounts).
 *
 * All functions read tokens/ids from environment variables at call time and
 * return a normalised `{ ok, data?, error? }` result. They never throw on a
 * missing env var or an API error.
 */

import { fetchJson } from './fetcher';

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface ToolResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

function requireEnv(name: string): { value?: string; error?: string } {
  const value = process.env[name];
  if (!value || !value.trim()) {
    return { error: `${name} is not set. Add it to your environment / Vercel project settings.` };
  }
  return { value: value.trim() };
}

function graphUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Resolve a since/until window (unix seconds) from either explicit dates or a `days` count. */
export function resolveWindow(opts: {
  days?: number;
  since?: string;
  until?: string;
}): { since: number; until: number } {
  const toUnix = (s?: string): number | undefined => {
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return parseInt(s, 10); // already unix seconds
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const until = toUnix(opts.until) ?? nowSec;
  const days = opts.days && opts.days > 0 ? opts.days : 7;
  const since = toUnix(opts.since) ?? until - days * 86_400;
  return { since, until };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram
// ─────────────────────────────────────────────────────────────────────────────

export async function getInstagramOverview(): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };
  const ig = requireEnv('META_IG_USER_ID');
  if (ig.error) return { ok: false, error: ig.error };

  const fields =
    'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';
  const res = await fetchJson(graphUrl(ig.value!, { fields, access_token: token.value! }));
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function getInstagramInsights(opts: {
  days?: number;
  since?: string;
  until?: string;
  metrics?: string;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };
  const ig = requireEnv('META_IG_USER_ID');
  if (ig.error) return { ok: false, error: ig.error };

  const { since, until } = resolveWindow(opts);
  const metric = (opts.metrics && opts.metrics.trim()) || 'reach,profile_views,follower_count';

  const res = await fetchJson(
    graphUrl(`${ig.value!}/insights`, {
      metric,
      period: 'day',
      since,
      until,
      access_token: token.value!,
    }),
  );
  if (!res.ok) {
    return {
      ok: false,
      error: `${res.error}\nNote: Instagram deprecates/renames insight metrics over time. Try the \`metrics\` param (e.g. "reach,profile_views").`,
    };
  }
  return { ok: true, data: { window: { since, until }, metric, ...res.data } };
}

export async function getInstagramRecentMedia(opts: {
  limit?: number;
  includeInsights?: boolean;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };
  const ig = requireEnv('META_IG_USER_ID');
  if (ig.error) return { ok: false, error: ig.error };

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const includeInsights = opts.includeInsights !== false;

  const fields =
    'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
  const listRes = await fetchJson(
    graphUrl(`${ig.value!}/media`, { fields, limit, access_token: token.value! }),
  );
  if (!listRes.ok) return { ok: false, error: listRes.error };

  const media: any[] = listRes.data?.data ?? [];

  if (includeInsights && media.length) {
    await Promise.all(
      media.map(async (m) => {
        // `reach` works across media types; add interaction metric, tolerate failures per-post.
        const insRes = await fetchJson(
          graphUrl(`${m.id}/insights`, {
            metric: 'reach,total_interactions',
            access_token: token.value!,
          }),
        );
        if (insRes.ok) {
          const byName: Record<string, any> = {};
          for (const item of insRes.data?.data ?? []) {
            byName[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? null;
          }
          m.insights = byName;
        } else {
          m.insights_error = insRes.error;
        }
      }),
    );
  }

  return { ok: true, data: { count: media.length, media } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Facebook Page
// ─────────────────────────────────────────────────────────────────────────────

export async function getFacebookPageInsights(opts: {
  days?: number;
  since?: string;
  until?: string;
  metrics?: string;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };
  const page = requireEnv('META_PAGE_ID');
  if (page.error) return { ok: false, error: page.error };

  // Page node fields (fan_count is a lifetime number, not an insight time-series).
  const nodeRes = await fetchJson(
    graphUrl(page.value!, {
      fields: 'id,name,fan_count,followers_count',
      access_token: token.value!,
    }),
  );

  const { since, until } = resolveWindow(opts);
  const metric =
    (opts.metrics && opts.metrics.trim()) ||
    'page_impressions,page_post_engagements,page_fans';
  const insightsRes = await fetchJson(
    graphUrl(`${page.value!}/insights`, {
      metric,
      period: 'day',
      since,
      until,
      access_token: token.value!,
    }),
  );

  // Surface partial results: node info and insights are independent calls.
  if (!nodeRes.ok && !insightsRes.ok) {
    return { ok: false, error: `${nodeRes.error} | insights: ${insightsRes.error}` };
  }

  return {
    ok: true,
    data: {
      page: nodeRes.ok ? nodeRes.data : { error: nodeRes.error },
      window: { since, until },
      metric,
      insights: insightsRes.ok ? insightsRes.data : { error: insightsRes.error },
    },
  };
}
