/**
 * Meta Graph API helpers (Facebook Pages + Instagram Business accounts).
 *
 * All functions read tokens/ids from environment variables at call time and
 * return a normalised `{ ok, data?, error? }` result. They never throw on a
 * missing env var or an API error. Field/metric requests are made resilient so
 * a single deprecated field/metric does not fail the whole tool.
 */

import { fetchJson } from './fetcher';

// Current, supported Graph API version.
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
// Instagram Business Account id resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Instagram Business Account id robustly.
 *
 * 1. If META_IG_USER_ID is set, validate it really is an IG account (requesting
 *    an IG-only field). If valid, use it.
 * 2. Otherwise (missing, or it's actually a Page id / invalid), derive the real
 *    IG Business Account id from META_PAGE_ID via
 *    `?fields=instagram_business_account{id,username}`.
 */
export async function resolveIgUserId(
  token: string,
): Promise<{ id?: string; source?: string; username?: string; error?: string }> {
  const configured = process.env.META_IG_USER_ID?.trim();
  const page = process.env.META_PAGE_ID?.trim();

  if (configured) {
    const test = await fetchJson(
      graphUrl(configured, { fields: 'id,username', access_token: token }),
    );
    if (test.ok && test.data?.username !== undefined) {
      return { id: configured, source: 'META_IG_USER_ID', username: test.data.username };
    }
    // configured id is wrong or is actually a Page id → try to auto-resolve below.
  }

  if (page) {
    const res = await fetchJson(
      graphUrl(page, {
        fields: 'instagram_business_account{id,username,name}',
        access_token: token,
      }),
    );
    if (res.ok && res.data?.instagram_business_account?.id) {
      const iba = res.data.instagram_business_account;
      return {
        id: iba.id,
        username: iba.username,
        source: configured
          ? `auto-derived from META_PAGE_ID (META_IG_USER_ID="${configured}" was not a valid IG account)`
          : 'auto-derived from META_PAGE_ID',
      };
    }
    if (res.ok && !res.data?.instagram_business_account) {
      return {
        error:
          'META_PAGE_ID has no linked instagram_business_account. Link an Instagram Business/Creator account to this Facebook Page in Meta settings.',
      };
    }
    return {
      error: `Could not resolve an Instagram Business Account from META_PAGE_ID: ${
        res.error || 'instagram_business_account not found on Page.'
      }`,
    };
  }

  if (configured) {
    return {
      error: `META_IG_USER_ID ("${configured}") is not a valid Instagram Business Account id, and META_PAGE_ID is not set to auto-resolve it. Set META_PAGE_ID (the linked Facebook Page id) or a correct META_IG_USER_ID.`,
    };
  }
  return {
    error:
      'Neither META_IG_USER_ID nor META_PAGE_ID is set; cannot resolve an Instagram Business Account.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram
// ─────────────────────────────────────────────────────────────────────────────

export async function getInstagramOverview(): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };

  const igId = await resolveIgUserId(token.value!);
  if (igId.error || !igId.id) return { ok: false, error: igId.error };

  const fields =
    'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';
  const res = await fetchJson(graphUrl(igId.id, { fields, access_token: token.value! }));
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: { ig_user_id: igId.id, ig_user_id_source: igId.source, ...res.data } };
}

export async function getInstagramInsights(opts: {
  days?: number;
  since?: string;
  until?: string;
  metrics?: string;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };

  const igId = await resolveIgUserId(token.value!);
  if (igId.error || !igId.id) return { ok: false, error: igId.error };

  const { since, until } = resolveWindow(opts);
  const metric = (opts.metrics && opts.metrics.trim()) || 'reach,profile_views,follower_count';

  const res = await fetchJson(
    graphUrl(`${igId.id}/insights`, {
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
  return {
    ok: true,
    data: {
      ig_user_id: igId.id,
      ig_user_id_source: igId.source,
      window: { since, until },
      metric,
      ...res.data,
    },
  };
}

export async function getInstagramRecentMedia(opts: {
  limit?: number;
  includeInsights?: boolean;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };

  const igId = await resolveIgUserId(token.value!);
  if (igId.error || !igId.id) return { ok: false, error: igId.error };

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const includeInsights = opts.includeInsights !== false;

  const fields =
    'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
  const listRes = await fetchJson(
    graphUrl(`${igId.id}/media`, { fields, limit, access_token: token.value! }),
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

  return {
    ok: true,
    data: { ig_user_id: igId.id, ig_user_id_source: igId.source, count: media.length, media },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Facebook Page
// ─────────────────────────────────────────────────────────────────────────────

// A conservative set of Page insight metrics that are valid in current Graph API
// versions. Each is requested independently so a deprecated/invalid one only
// drops itself instead of failing the whole tool.
const SAFE_PAGE_METRICS = [
  'page_impressions',
  'page_post_engagements',
  'page_views_total',
  'page_fan_adds',
];

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

  // Page node fields — only currently-valid ones. `fan_count` is deprecated;
  // use `followers_count`.
  const nodeRes = await fetchJson(
    graphUrl(page.value!, {
      fields: 'id,name,followers_count',
      access_token: token.value!,
    }),
  );

  const { since, until } = resolveWindow(opts);
  const metricList = (
    opts.metrics && opts.metrics.trim()
      ? opts.metrics.split(',')
      : SAFE_PAGE_METRICS
  )
    .map((m) => m.trim())
    .filter(Boolean);

  // Request each metric independently so one rejected metric doesn't fail all.
  const perMetric = await Promise.all(
    metricList.map(async (metric) => {
      const r = await fetchJson(
        graphUrl(`${page.value!}/insights`, {
          metric,
          period: 'day',
          since,
          until,
          access_token: token.value!,
        }),
      );
      return { metric, ok: r.ok, data: r.ok ? r.data?.data : undefined, error: r.error };
    }),
  );

  const insights: Record<string, any> = {};
  const insightErrors: Record<string, string> = {};
  for (const x of perMetric) {
    if (x.ok) insights[x.metric] = x.data;
    else insightErrors[x.metric] = x.error ?? 'unknown error';
  }

  // Only a hard failure if the Page node call failed AND no metric succeeded.
  if (!nodeRes.ok && Object.keys(insights).length === 0) {
    return {
      ok: false,
      error: `Page node: ${nodeRes.error}; all requested insight metrics failed (${Object.values(
        insightErrors,
      ).join(' | ')})`,
    };
  }

  return {
    ok: true,
    data: {
      page: nodeRes.ok ? nodeRes.data : { error: nodeRes.error },
      window: { since, until },
      metrics_requested: metricList,
      insights,
      ...(Object.keys(insightErrors).length ? { insight_errors: insightErrors } : {}),
    },
  };
}
