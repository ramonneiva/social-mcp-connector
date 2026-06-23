/**
 * Meta Graph API helpers (Facebook Pages + Instagram Business accounts).
 *
 * All functions read tokens/ids from environment variables at call time and
 * return a normalised `{ ok, data?, error? }` result. They never throw on a
 * missing env var or an API error. Field/metric requests are made resilient so
 * a single deprecated field/metric does not fail the whole tool.
 *
 * Robust id/token discovery (`resolveMetaContext`):
 *   - Calls GET /me/accounts to find the Page the token manages, its PAGE
 *     access token (required for Page insights), and any linked Instagram
 *     Business account.
 *   - Page:  valid META_PAGE_ID (matched in /me/accounts) → first managed Page.
 *   - IG id: valid META_IG_USER_ID → instagram_business_account on META_PAGE_ID
 *            → instagram_business_account from the discovered Page.
 *   - Reports which id/token was used and its source; never logs tokens.
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
// Discovery: resolve Page id + PAGE token + IG Business Account id
// ─────────────────────────────────────────────────────────────────────────────

export interface MetaContext {
  /** Selected Facebook Page id (env or discovered). */
  pageId?: string;
  pageName?: string;
  /** PAGE access token for this page (needed for Page insights). */
  pageToken?: string;
  pageSource?: string;
  /** Resolved Instagram Business Account id. */
  igId?: string;
  igUsername?: string;
  igSource?: string;
  /** Number of Pages the token manages (from /me/accounts). */
  pagesFound?: number;
  /** Discovery-level error (e.g. token manages no Pages). */
  discoveryError?: string;
}

interface MePage {
  id: string;
  name?: string;
  access_token?: string;
  followers_count?: number;
  instagram_business_account?: { id?: string; username?: string; followers_count?: number };
}

// Short-lived in-memory memo so a single request (e.g. social_overview) doesn't
// re-run discovery for the same token. Token value is the key but is never logged.
const _memo = new Map<string, { ctx: MetaContext; ts: number }>();
const MEMO_TTL_MS = 60_000;

async function fetchManagedPages(
  userToken: string,
): Promise<{ pages?: MePage[]; error?: string }> {
  const res = await fetchJson(
    graphUrl('me/accounts', {
      fields:
        'id,name,access_token,followers_count,instagram_business_account{id,username,followers_count}',
      limit: 100,
      access_token: userToken,
    }),
  );
  if (!res.ok) return { error: res.error };
  return { pages: (res.data?.data as MePage[]) ?? [] };
}

/** Validate that an id is really an IG account by requesting an IG-only field. */
async function validateIgId(
  userToken: string,
  id: string,
): Promise<{ ok: boolean; username?: string }> {
  const test = await fetchJson(graphUrl(id, { fields: 'id,username', access_token: userToken }));
  if (test.ok && test.data?.username !== undefined) return { ok: true, username: test.data.username };
  return { ok: false };
}

/**
 * Resolve Page + PAGE token + IG id from env + /me/accounts. Memoised per token.
 */
export async function resolveMetaContext(userToken: string): Promise<MetaContext> {
  const cached = _memo.get(userToken);
  if (cached && Date.now() - cached.ts < MEMO_TTL_MS) return cached.ctx;

  const configuredPage = process.env.META_PAGE_ID?.trim();
  const configuredIg = process.env.META_IG_USER_ID?.trim();
  const ctx: MetaContext = {};

  // 1. Discover managed pages (also yields the PAGE access token + linked IG).
  const discovery = await fetchManagedPages(userToken);
  if (discovery.error) {
    ctx.discoveryError = `Could not list Pages via /me/accounts: ${discovery.error}. The token likely lacks the pages_show_list / pages_read_engagement scopes.`;
  }
  const pages = discovery.pages ?? [];
  ctx.pagesFound = pages.length;

  // 2. Select the Page (+ its page token).
  let selected: MePage | undefined;
  if (configuredPage) {
    const match = pages.find((p) => p.id === configuredPage);
    if (match) {
      selected = match;
      ctx.pageSource = 'META_PAGE_ID (matched in /me/accounts)';
    }
  }
  if (!selected && pages.length) {
    selected = pages[0];
    ctx.pageSource = configuredPage
      ? `first Page from /me/accounts (META_PAGE_ID "${configuredPage}" is not among the managed Pages)`
      : 'first Page from /me/accounts';
  }
  if (selected) {
    ctx.pageId = selected.id;
    ctx.pageName = selected.name;
    ctx.pageToken = selected.access_token;
  } else if (!ctx.discoveryError) {
    ctx.discoveryError =
      'The token manages no Facebook Pages (/me/accounts returned 0). Ensure the user has a Facebook Page with a linked Instagram Business/Creator account, and that the token has pages_show_list, pages_read_engagement (and instagram_basic, instagram_manage_insights for IG).';
  }

  // 3. Resolve the IG Business Account id, in the requested order.
  // 3a. valid META_IG_USER_ID
  if (configuredIg) {
    const v = await validateIgId(userToken, configuredIg);
    if (v.ok) {
      ctx.igId = configuredIg;
      ctx.igUsername = v.username;
      ctx.igSource = 'META_IG_USER_ID';
    }
  }
  // 3b. instagram_business_account on META_PAGE_ID
  if (!ctx.igId && configuredPage) {
    const res = await fetchJson(
      graphUrl(configuredPage, {
        fields: 'instagram_business_account{id,username}',
        access_token: userToken,
      }),
    );
    const iba = res.ok ? res.data?.instagram_business_account : undefined;
    if (iba?.id) {
      ctx.igId = iba.id;
      ctx.igUsername = iba.username;
      ctx.igSource = 'derived from instagram_business_account on META_PAGE_ID';
    }
  }
  // 3c. instagram_business_account from the discovered Page
  if (!ctx.igId && selected?.instagram_business_account?.id) {
    ctx.igId = selected.instagram_business_account.id;
    ctx.igUsername = selected.instagram_business_account.username;
    ctx.igSource = `derived from /me/accounts Page ${selected.id}`;
  }

  _memo.set(userToken, { ctx, ts: Date.now() });
  return ctx;
}

/** Build a clear IG-resolution error from the context. */
function igError(ctx: MetaContext): string {
  if (ctx.discoveryError) return ctx.discoveryError;
  return (
    'Could not resolve an Instagram Business Account. Provide a valid META_IG_USER_ID, or a ' +
    'META_PAGE_ID / token whose Page has a linked Instagram Business/Creator account ' +
    '(scopes: instagram_basic, instagram_manage_insights).'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram
// ─────────────────────────────────────────────────────────────────────────────

export async function getInstagramOverview(): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };

  const ctx = await resolveMetaContext(token.value!);
  if (!ctx.igId) return { ok: false, error: igError(ctx) };

  const fields =
    'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';
  const res = await fetchJson(graphUrl(ctx.igId, { fields, access_token: token.value! }));
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    data: { ig_user_id: ctx.igId, ig_user_id_source: ctx.igSource, ...res.data },
  };
}

export async function getInstagramInsights(opts: {
  days?: number;
  since?: string;
  until?: string;
  metrics?: string;
}): Promise<ToolResult> {
  const token = requireEnv('META_ACCESS_TOKEN');
  if (token.error) return { ok: false, error: token.error };

  const ctx = await resolveMetaContext(token.value!);
  if (!ctx.igId) return { ok: false, error: igError(ctx) };

  const { since, until } = resolveWindow(opts);
  const metric = (opts.metrics && opts.metrics.trim()) || 'reach,profile_views,follower_count';

  const res = await fetchJson(
    graphUrl(`${ctx.igId}/insights`, {
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
      ig_user_id: ctx.igId,
      ig_user_id_source: ctx.igSource,
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

  const ctx = await resolveMetaContext(token.value!);
  if (!ctx.igId) return { ok: false, error: igError(ctx) };

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const includeInsights = opts.includeInsights !== false;

  const fields =
    'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
  const listRes = await fetchJson(
    graphUrl(`${ctx.igId}/media`, { fields, limit, access_token: token.value! }),
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
    data: {
      ig_user_id: ctx.igId,
      ig_user_id_source: ctx.igSource,
      count: media.length,
      media,
    },
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

  const ctx = await resolveMetaContext(token.value!);
  if (!ctx.pageId) {
    return {
      ok: false,
      error:
        ctx.discoveryError ??
        'No Facebook Page could be resolved for this token. Set META_PAGE_ID or ensure the token manages a Page (pages_show_list, pages_read_engagement).',
    };
  }

  // Page insights REQUIRE a PAGE access token. Use the discovered one; fall back
  // to the user token only if the page token is unavailable.
  const pageToken = ctx.pageToken || token.value!;
  const usingPageToken = Boolean(ctx.pageToken);

  // Page node fields — only currently-valid ones (`fan_count` is deprecated).
  const nodeRes = await fetchJson(
    graphUrl(ctx.pageId, { fields: 'id,name,followers_count', access_token: pageToken }),
  );

  const { since, until } = resolveWindow(opts);
  const metricList = (
    opts.metrics && opts.metrics.trim() ? opts.metrics.split(',') : SAFE_PAGE_METRICS
  )
    .map((m) => m.trim())
    .filter(Boolean);

  // Request each metric independently so one rejected metric doesn't fail all.
  const perMetric = await Promise.all(
    metricList.map(async (metric) => {
      const r = await fetchJson(
        graphUrl(`${ctx.pageId}/insights`, {
          metric,
          period: 'day',
          since,
          until,
          access_token: pageToken,
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
      page_id: ctx.pageId,
      page_id_source: ctx.pageSource,
      using_page_token: usingPageToken,
      pages_managed: ctx.pagesFound,
      page: nodeRes.ok ? nodeRes.data : { error: nodeRes.error },
      window: { since, until },
      metrics_requested: metricList,
      insights,
      ...(Object.keys(insightErrors).length ? { insight_errors: insightErrors } : {}),
    },
  };
}
