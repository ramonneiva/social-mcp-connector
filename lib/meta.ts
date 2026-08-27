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
 *   - Page: valid META_PAGE_ID (matched in /me/accounts) → first managed Page.
 *   - IG id: valid META_IG_USER_ID → instagram_business_account on META_PAGE_ID
 *            → instagram_business_account from the discovered Page.
 *   - Reports which id/token was used and its source; never logs tokens.
 */

import { fetchJson } from './fetcher';

// Graph API version validated with this Instagram integration.
export const GRAPH_VERSION = 'v26.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface ToolResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

function requireEnv(name: string): { value?: string; error?: string } {
  const value = process.env[name];

  if (!value || !value.trim()) {
    return {
      error: `${name} is not set. Add it to your environment / Vercel project settings.`,
    };
  }

  return { value: value.trim() };
}

function graphUrl(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, '')}`);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  return url.toString();
}

/**
 * Resolve a since/until window (unix seconds) from either explicit dates
 * or a `days` count.
 */
export function resolveWindow(opts: {
  days?: number;
  since?: string;
  until?: string;
}): { since: number; until: number } {
  const toUnix = (s?: string): number | undefined => {
    if (!s) return undefined;

    if (/^\d+$/.test(s)) {
      return parseInt(s, 10);
    }

    const t = Date.parse(s);

    return Number.isNaN(t)
      ? undefined
      : Math.floor(t / 1000);
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

  /** Discovery-level error. */
  discoveryError?: string;
}

interface MePage {
  id: string;
  name?: string;
  access_token?: string;
  followers_count?: number;

  instagram_business_account?: {
    id?: string;
    username?: string;
    followers_count?: number;
  };
}

// Short-lived in-memory memo so a single request doesn't run discovery repeatedly.
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

  if (!res.ok) {
    return { error: res.error };
  }

  return {
    pages: (res.data?.data as MePage[]) ?? [],
  };
}

/** Validate that an id is really an IG account. */
async function validateIgId(
  userToken: string,
  id: string,
): Promise<{ ok: boolean; username?: string }> {
  const test = await fetchJson(
    graphUrl(id, {
      fields: 'id,username',
      access_token: userToken,
    }),
  );

  if (test.ok && test.data?.username !== undefined) {
    return {
      ok: true,
      username: test.data.username,
    };
  }

  return { ok: false };
}

/**
 * Resolve Page + PAGE token + IG id from env + /me/accounts.
 * Memoised per token.
 */
export async function resolveMetaContext(
  userToken: string,
): Promise<MetaContext> {
  const cached = _memo.get(userToken);

  if (cached && Date.now() - cached.ts < MEMO_TTL_MS) {
    return cached.ctx;
  }

  const configuredPage =
    process.env.META_PAGE_ID?.trim();

  const configuredIg =
    process.env.META_IG_USER_ID?.trim();

  const ctx: MetaContext = {};

  // 1. Discover managed pages.
  const discovery =
    await fetchManagedPages(userToken);

  if (discovery.error) {
    ctx.discoveryError =
      `Could not list Pages via /me/accounts: ${discovery.error}. ` +
      `The token likely lacks the pages_show_list / pages_read_engagement scopes.`;
  }

  const pages =
    discovery.pages ?? [];

  ctx.pagesFound =
    pages.length;

  // 2. Select Page.
  let selected: MePage | undefined;

  if (configuredPage) {
    const match =
      pages.find((p) => p.id === configuredPage);

    if (match) {
      selected = match;

      ctx.pageSource =
        'META_PAGE_ID (matched in /me/accounts)';
    }
  }

  if (!selected && pages.length) {
    selected = pages[0];

    ctx.pageSource =
      configuredPage
        ? `first Page from /me/accounts (META_PAGE_ID "${configuredPage}" is not among the managed Pages)`
        : 'first Page from /me/accounts';
  }

  if (selected) {
    ctx.pageId =
      selected.id;

    ctx.pageName =
      selected.name;

    ctx.pageToken =
      selected.access_token;
  } else if (!ctx.discoveryError) {
    ctx.discoveryError =
      'The token manages no Facebook Pages (/me/accounts returned 0). ' +
      'Ensure the user has a Facebook Page with a linked Instagram ' +
      'Business/Creator account, and that the token has pages_show_list, ' +
      'pages_read_engagement, instagram_basic and instagram_manage_insights.';
  }

  // 3a. Valid META_IG_USER_ID.
  if (configuredIg) {
    const v =
      await validateIgId(
        userToken,
        configuredIg,
      );

    if (v.ok) {
      ctx.igId =
        configuredIg;

      ctx.igUsername =
        v.username;

      ctx.igSource =
        'META_IG_USER_ID';
    }
  }

  // 3b. Instagram account on META_PAGE_ID.
  if (!ctx.igId && configuredPage) {
    const res =
      await fetchJson(
        graphUrl(configuredPage, {
          fields:
            'instagram_business_account{id,username}',
          access_token:
            userToken,
        }),
      );

    const iba =
      res.ok
        ? res.data?.instagram_business_account
        : undefined;

    if (iba?.id) {
      ctx.igId =
        iba.id;

      ctx.igUsername =
        iba.username;

      ctx.igSource =
        'derived from instagram_business_account on META_PAGE_ID';
    }
  }

  // 3c. Instagram account from discovered Page.
  if (
    !ctx.igId &&
    selected?.instagram_business_account?.id
  ) {
    ctx.igId =
      selected.instagram_business_account.id;

    ctx.igUsername =
      selected.instagram_business_account.username;

    ctx.igSource =
      `derived from /me/accounts Page ${selected.id}`;
  }

  _memo.set(userToken, {
    ctx,
    ts: Date.now(),
  });

  return ctx;
}

/** Build a clear IG-resolution error from the context. */
function igError(
  ctx: MetaContext,
): string {
  if (ctx.discoveryError) {
    return ctx.discoveryError;
  }

  return (
    'Could not resolve an Instagram Business Account. Provide a valid ' +
    'META_IG_USER_ID, or a META_PAGE_ID / token whose Page has a linked ' +
    'Instagram Business/Creator account ' +
    '(scopes: instagram_basic, instagram_manage_insights).'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram
// ─────────────────────────────────────────────────────────────────────────────

export async function getInstagramOverview(): Promise<ToolResult> {
  const token =
    requireEnv('META_ACCESS_TOKEN');

  if (token.error) {
    return {
      ok: false,
      error: token.error,
    };
  }

  const ctx =
    await resolveMetaContext(
      token.value!,
    );

  if (!ctx.igId) {
    return {
      ok: false,
      error: igError(ctx),
    };
  }

  const fields =
    'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';

  const res =
    await fetchJson(
      graphUrl(ctx.igId, {
        fields,
        access_token:
          token.value!,
      }),
    );

  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
    };
  }

  return {
    ok: true,
    data: {
      ig_user_id:
        ctx.igId,

      ig_user_id_source:
        ctx.igSource,

      ...res.data,
    },
  };
}

export async function getInstagramInsights(opts: {
  days?: number;
  since?: string;
  until?: string;
  metrics?: string;
}): Promise<ToolResult> {
  const token =
    requireEnv('META_ACCESS_TOKEN');

  if (token.error) {
    return {
      ok: false,
      error: token.error,
    };
  }

  const ctx =
    await resolveMetaContext(
      token.value!,
    );

  if (!ctx.igId) {
    return {
      ok: false,
      error: igError(ctx),
    };
  }

  const { since, until } =
    resolveWindow(opts);

  const metric =
    (opts.metrics &&
      opts.metrics.trim()) ||
    'reach,profile_views,follower_count';

  const res =
    await fetchJson(
      graphUrl(
        `${ctx.igId}/insights`,
        {
          metric,
          period: 'day',
          since,
          until,
          access_token:
            token.value!,
        },
      ),
    );

  if (!res.ok) {
    return {
      ok: false,
      error:
        `${res.error}\n` +
        'Note: Instagram deprecates/renames insight metrics over time. ' +
        'Try the `metrics` param.',
    };
  }

  return {
    ok: true,
    data: {
      ig_user_id:
        ctx.igId,

      ig_user_id_source:
        ctx.igSource,

      window: {
        since,
        until,
      },

      metric,

      ...res.data,
    },
  };
}

/**
 * Reel metrics already validated against this account / Graph API v26.
 *
 * Each metric is requested separately so one unavailable/deprecated metric
 * does not cause every Reel insight to fail.
 */
const REEL_INSIGHT_METRICS = [
  'views',
  'reach',
  'shares',
  'saved',
  'likes',
  'comments',
  'ig_reels_video_view_total_time',
  'ig_reels_avg_watch_time',
  'reels_skip_rate',
  'total_interactions',
  'reposts',
];

export async function getInstagramRecentMedia(opts: {
  limit?: number;
  includeInsights?: boolean;
}): Promise<ToolResult> {
  const token =
    requireEnv('META_ACCESS_TOKEN');

  if (token.error) {
    return {
      ok: false,
      error: token.error,
    };
  }

  const ctx =
    await resolveMetaContext(
      token.value!,
    );

  if (!ctx.igId) {
    return {
      ok: false,
      error: igError(ctx),
    };
  }

  // Quantidade total solicitada pela ferramenta MCP.
  // A Meta pagina os resultados, então seguimos paging.next automaticamente.
  const requestedLimit =
    Math.min(
      Math.max(
        opts.limit ?? 50,
        1,
      ),
      500,
    );

  const includeInsights =
    opts.includeInsights !== false;

  const fields =
    'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';

  const media: any[] = [];

  // Primeira página da Meta.
  let nextUrl:
    | string
    | undefined =
    graphUrl(
      `${ctx.igId}/media`,
      {
        fields,

        // Tamanho de cada página.
        // O requestedLimit continua sendo o limite total.
        limit:
          Math.min(
            requestedLimit,
            100,
          ),

        access_token:
          token.value!,
      },
    );

  // Continua buscando páginas até atingir a quantidade solicitada
  // ou até a Meta informar que não há mais resultados.
  while (
    nextUrl &&
    media.length <
      requestedLimit
  ) {
const pageRes: any =
  await fetchJson(
    nextUrl,
  );
      );

    if (!pageRes.ok) {
      return {
        ok: false,
        error:
          pageRes.error,
      };
    }

    const pageItems:
      any[] =
      pageRes.data?.data ??
      [];

    media.push(
      ...pageItems,
    );

    if (!pageItems.length) {
      break;
    }

    nextUrl =
      pageRes.data
        ?.paging
        ?.next;
  }

  // Nunca devolve mais do que foi solicitado.
  const selectedMedia =
    media.slice(
      0,
      requestedLimit,
    );

  if (
    includeInsights &&
    selectedMedia.length
  ) {
    /**
     * Evita disparar centenas de chamadas simultaneamente
     * quando analisarmos 100, 200 ou mais Reels.
     */
    const CONCURRENCY = 8;

    for (
      let i = 0;
      i <
      selectedMedia.length;
      i += CONCURRENCY
    ) {
      const batch =
        selectedMedia.slice(
          i,
          i + CONCURRENCY,
        );

      await Promise.all(
        batch.map(
          async (m) => {
            const insights:
              Record<
                string,
                any
              > = {};

            const insightErrors:
              Record<
                string,
                string
              > = {};

            const metrics =
              m.media_product_type ===
              'REELS'
                ? REEL_INSIGHT_METRICS
                : [
                    'reach',
                    'total_interactions',
                  ];

            /**
             * Primeiro tenta buscar todas as métricas daquele Reel
             * numa única chamada.
             *
             * Isso reduz drasticamente a quantidade de requests.
             */
            const combined =
              await fetchJson(
                graphUrl(
                  `${m.id}/insights`,
                  {
                    metric:
                      metrics.join(
                        ',',
                      ),

                    access_token:
                      token.value!,
                  },
                ),
              );

            if (combined.ok) {
              for (
                const item of
                  combined.data
                    ?.data ?? []
              ) {
                insights[
                  item.name
                ] =
                  item.values
                    ?.[0]
                    ?.value ??
                  item
                    .total_value
                    ?.value ??
                  null;
              }
            } else {
              /**
               * Fallback:
               *
               * Se uma métrica fizer a chamada conjunta falhar,
               * busca cada métrica individualmente.
               *
               * Assim uma métrica incompatível não derruba todas as outras.
               */
              const results =
                await Promise.all(
                  metrics.map(
                    async (
                      metric,
                    ) => {
                      const response =
                        await fetchJson(
                          graphUrl(
                            `${m.id}/insights`,
                            {
                              metric,

                              access_token:
                                token.value!,
                            },
                          ),
                        );

                      return {
                        metric,
                        response,
                      };
                    },
                  ),
                );

              for (
                const result of
                  results
              ) {
                const {
                  metric,
                  response,
                } = result;

                if (
                  response.ok
                ) {
                  const item =
                    response
                      .data
                      ?.data
                      ?.[0];

                  insights[
                    metric
                  ] =
                    item
                      ?.values
                      ?.[0]
                      ?.value ??
                    item
                      ?.total_value
                      ?.value ??
                    null;
                } else {
                  insightErrors[
                    metric
                  ] =
                    response
                      .error ??
                    'unknown error';
                }
              }
            }

            m.insights =
              insights;

            if (
              Object.keys(
                insightErrors,
              ).length
            ) {
              m.insight_errors =
                insightErrors;
            }
          },
        ),
      );
    }
  }

  return {
    ok: true,

    data: {
      ig_user_id:
        ctx.igId,

      ig_user_id_source:
        ctx.igSource,

      requested_limit:
        requestedLimit,

      count:
        selectedMedia.length,

      media:
        selectedMedia,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Facebook Page
// ─────────────────────────────────────────────────────────────────────────────

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
  const token =
    requireEnv('META_ACCESS_TOKEN');

  if (token.error) {
    return {
      ok: false,
      error: token.error,
    };
  }

  const ctx =
    await resolveMetaContext(
      token.value!,
    );

  if (!ctx.pageId) {
    return {
      ok: false,

      error:
        ctx.discoveryError ??
        'No Facebook Page could be resolved for this token. ' +
          'Set META_PAGE_ID or ensure the token manages a Page.',
    };
  }

  // Page insights require a PAGE access token.
  const pageToken =
    ctx.pageToken ||
    token.value!;

  const usingPageToken =
    Boolean(
      ctx.pageToken,
    );

  const nodeRes =
    await fetchJson(
      graphUrl(
        ctx.pageId,
        {
          fields:
            'id,name,followers_count',

          access_token:
            pageToken,
        },
      ),
    );

  const { since, until } =
    resolveWindow(opts);

  const metricList =
    (
      opts.metrics &&
      opts.metrics.trim()
        ? opts.metrics.split(
            ',',
          )
        : SAFE_PAGE_METRICS
    )
      .map(
        (m) => m.trim(),
      )
      .filter(Boolean);

  // Request each Page metric independently.
  const perMetric =
    await Promise.all(
      metricList.map(
        async (
          metric,
        ) => {
          const r =
            await fetchJson(
              graphUrl(
                `${ctx.pageId}/insights`,
                {
                  metric,
                  period:
                    'day',
                  since,
                  until,

                  access_token:
                    pageToken,
                },
              ),
            );

          return {
            metric,

            ok: r.ok,

            data:
              r.ok
                ? r.data
                    ?.data
                : undefined,

            error:
              r.error,
          };
        },
      ),
    );

  const insights:
    Record<
      string,
      any
    > = {};

  const insightErrors:
    Record<
      string,
      string
    > = {};

  for (
    const x of
      perMetric
  ) {
    if (x.ok) {
      insights[
        x.metric
      ] = x.data;
    } else {
      insightErrors[
        x.metric
      ] =
        x.error ??
        'unknown error';
    }
  }

  // Hard failure only if Page node AND every metric failed.
  if (
    !nodeRes.ok &&
    Object.keys(
      insights,
    ).length === 0
  ) {
    return {
      ok: false,

      error:
        `Page node: ${nodeRes.error}; ` +
        `all requested insight metrics failed (` +
        `${Object.values(
          insightErrors,
        ).join(' | ')})`,
    };
  }

  return {
    ok: true,

    data: {
      page_id:
        ctx.pageId,

      page_id_source:
        ctx.pageSource,

      using_page_token:
        usingPageToken,

      pages_managed:
        ctx.pagesFound,

      page:
        nodeRes.ok
          ? nodeRes.data
          : {
              error:
                nodeRes.error,
            },

      window: {
        since,
        until,
      },

      metrics_requested:
        metricList,

      insights,

      ...(Object.keys(
        insightErrors,
      ).length
        ? {
            insight_errors:
              insightErrors,
          }
        : {}),
    },
  };
}
