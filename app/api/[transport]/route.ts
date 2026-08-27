import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';

import {
  getInstagramOverview,
  getInstagramInsights,
  getInstagramRecentMedia,
  getFacebookPageInsights,
  type ToolResult,
} from '@/lib/meta';

import {
  getTikTokUserInfo,
  getTikTokRecentVideos,
} from '@/lib/tiktok';

export const dynamic = 'force-dynamic';

/**
 * Mantemos 60 segundos para compatibilidade com o deploy atual.
 * As consultas de Instagram foram otimizadas no meta.ts para reduzir
 * o número de chamadas à Graph API.
 */
export const maxDuration = 60;

// ── MCP content helpers ──────────────────────────────────────────────────────

type McpResult = {
  content: {
    type: 'text';
    text: string;
  }[];
  isError?: boolean;
};

function ok(
  summary: string,
  data: unknown,
): McpResult {
  const text =
    `${summary}\n\n\`\`\`json\n` +
    `${JSON.stringify(data, null, 2)}\n` +
    `\`\`\``;

  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function fail(
  message: string,
): McpResult {
  return {
    content: [
      {
        type: 'text',
        text: `❌ ${message}`,
      },
    ],
    isError: true,
  };
}

/**
 * Run a lib function and map its normalised result into an MCP result.
 */
async function run(
  summary: string,
  fn: () => Promise<ToolResult>,
): Promise<McpResult> {
  try {
    const r = await fn();

    if (!r.ok) {
      return fail(
        r.error ??
          'Unknown error',
      );
    }

    return ok(
      summary,
      r.data,
    );
  } catch (e: any) {
    // Defensive: a single tool error must never crash the server.
    return fail(
      `Unexpected error: ${
        e?.message ||
        String(e)
      }`,
    );
  }
}

// ── MCP handler ──────────────────────────────────────────────────────────────

const handler =
  createMcpHandler(
    (server) => {
      // ── Instagram ────────────────────────────────────────────────────────

      server.tool(
        'instagram_account_overview',

        'Instagram Business/Creator account profile: username, name, followers_count, follows_count, media_count, biography and profile picture. Requires META_ACCESS_TOKEN and META_IG_USER_ID.',

        {},

        async () =>
          run(
            'Instagram account overview',
            getInstagramOverview,
          ),
      );

      server.tool(
        'instagram_account_insights',

        'Instagram account insights such as reach, profile views and follower data over a time window. Defaults to the last 7 days. Requires META_ACCESS_TOKEN and META_IG_USER_ID.',

        {
          days: z
            .number()
            .int()
            .positive()
            .max(90)
            .optional()
            .describe(
              'Number of days back from now (default 7). Ignored if `since`/`until` are given.',
            ),

          since: z
            .string()
            .optional()
            .describe(
              'Start of window: unix seconds or YYYY-MM-DD.',
            ),

          until: z
            .string()
            .optional()
            .describe(
              'End of window: unix seconds or YYYY-MM-DD (default now).',
            ),

          metrics: z
            .string()
            .optional()
            .describe(
              'Comma-separated metric list. Default "reach,profile_views,follower_count".',
            ),
        },

        async (args) =>
          run(
            'Instagram account insights',
            () =>
              getInstagramInsights(
                args,
              ),
          ),
      );

      /**
       * Instagram media analysis.
       *
       * IMPORTANT:
       * The old MCP limited this tool to 25 media items.
       *
       * The updated meta.ts now follows Meta paging.next automatically,
       * so Claude can request substantially more historical Reels.
       */
      server.tool(
        'instagram_recent_media',

        'Instagram media history with per-post/Reel metrics. For Reels it can return views, reach, shares, saves, likes, comments, reposts, total interactions, total watch time, average watch time and skip rate when available. Supports automatic pagination for historical analysis. Requires META_ACCESS_TOKEN and META_IG_USER_ID.',

        {
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe(
              'Total number of recent Instagram media items to analyze. Supports 1-500; default 50. Results are automatically paginated through the Meta Graph API.',
            ),

          includeInsights: z
            .boolean()
            .optional()
            .describe(
              'Fetch per-media insights and advanced Reel performance metrics. Default true.',
            ),
        },

        async (args) =>
          run(
            'Instagram recent media',
            () =>
              getInstagramRecentMedia(
                args,
              ),
          ),
      );

      // ── Facebook Page ────────────────────────────────────────────────────

      server.tool(
        'facebook_page_insights',

        'Facebook Page insights: followers_count plus page_impressions, page_post_engagements, page_views_total and page_fan_adds over a time window (default last 7 days). Each metric is requested independently, so a deprecated or invalid metric is skipped rather than failing the entire tool. Requires META_ACCESS_TOKEN and META_PAGE_ID.',

        {
          days: z
            .number()
            .int()
            .positive()
            .max(90)
            .optional()
            .describe(
              'Days back from now (default 7).',
            ),

          since: z
            .string()
            .optional()
            .describe(
              'Start: unix seconds or YYYY-MM-DD.',
            ),

          until: z
            .string()
            .optional()
            .describe(
              'End: unix seconds or YYYY-MM-DD (default now).',
            ),

          metrics: z
            .string()
            .optional()
            .describe(
              'Comma-separated metrics. Default "page_impressions,page_post_engagements,page_views_total,page_fan_adds".',
            ),
        },

        async (args) =>
          run(
            'Facebook Page insights',
            () =>
              getFacebookPageInsights(
                args,
              ),
          ),
      );

      // ── TikTok ───────────────────────────────────────────────────────────

      server.tool(
        'tiktok_user_info',

        'TikTok creator account info: open_id, display_name, follower_count, following_count, likes_count and video_count. Requires TIKTOK_ACCESS_TOKEN.',

        {},

        async () =>
          run(
            'TikTok user info',
            getTikTokUserInfo,
          ),
      );

      server.tool(
        'tiktok_recent_videos',

        'Recent TikTok videos with view_count, like_count, comment_count and share_count. Requires TIKTOK_ACCESS_TOKEN.',

        {
          maxCount: z
            .number()
            .int()
            .positive()
            .max(20)
            .optional()
            .describe(
              'How many recent videos to return (1-20, default 10).',
            ),
        },

        async (args) =>
          run(
            'TikTok recent videos',
            () =>
              getTikTokRecentVideos(
                args,
              ),
          ),
      );

      // ── Aggregate ────────────────────────────────────────────────────────

      server.tool(
        'social_overview',

        'Convenience tool: aggregates headline numbers across Instagram, Facebook Page and TikTok into a single snapshot. Returns whatever platforms have valid tokens; per-platform errors are reported inline.',

        {},

        async () => {
          const [
            ig,
            fb,
            tt,
          ] =
            await Promise.all([
              getInstagramOverview(),

              getFacebookPageInsights(
                {
                  days: 7,
                },
              ),

              getTikTokUserInfo(),
            ]);

          const summary = {
            instagram:
              ig.ok
                ? {
                    username:
                      (
                        ig.data as any
                      )
                        ?.username,

                    followers_count:
                      (
                        ig.data as any
                      )
                        ?.followers_count,

                    media_count:
                      (
                        ig.data as any
                      )
                        ?.media_count,
                  }
                : {
                    error:
                      (
                        ig as any
                      ).error,
                  },

            facebook:
              fb.ok
                ? {
                    name:
                      (
                        fb.data as any
                      )
                        ?.page
                        ?.name,

                    followers_count:
                      (
                        fb.data as any
                      )
                        ?.page
                        ?.followers_count,
                  }
                : {
                    error:
                      (
                        fb as any
                      ).error,
                  },

            tiktok:
              tt.ok
                ? {
                    display_name:
                      (
                        tt.data as any
                      )
                        ?.display_name,

                    follower_count:
                      (
                        tt.data as any
                      )
                        ?.follower_count,

                    likes_count:
                      (
                        tt.data as any
                      )
                        ?.likes_count,

                    video_count:
                      (
                        tt.data as any
                      )
                        ?.video_count,
                  }
                : {
                    error:
                      (
                        tt as any
                      ).error,
                  },
          };

          return ok(
            'Social overview (Instagram + Facebook + TikTok)',
            summary,
          );
        },
      );
    },

    {
      // Server capabilities / metadata
      serverInfo: {
        name:
          'social-mcp-connector',

        version:
          '1.1.0',
      },
    },

    {
      /**
       * Adapter config.
       *
       * basePath "/api" creates:
       *   /api/mcp → Streamable HTTP
       *   /api/sse → SSE
       */
      basePath: '/api',

      maxDuration: 60,

      verboseLogs:
        process.env
          .NODE_ENV !==
        'production',

      /**
       * Redis is optional.
       * Streamable HTTP works without it.
       */
      redisUrl:
        process.env
          .REDIS_URL ||
        undefined,
    },
  );

// ── Optional shared-secret bearer auth ───────────────────────────────────────

async function authedHandler(
  req: Request,
): Promise<Response> {
  const required =
    process.env
      .MCP_AUTH_TOKEN;

  if (
    required &&
    required.trim()
  ) {
    const header =
      req.headers.get(
        'authorization',
      ) || '';

    const token =
      header
        .replace(
          /^Bearer\s+/i,
          '',
        )
        .trim();

    if (
      token !==
      required.trim()
    ) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',

          error: {
            code: -32001,

            message:
              'Unauthorized: missing or invalid bearer token',
          },

          id: null,
        }),

        {
          status: 401,

          headers: {
            'content-type':
              'application/json',
          },
        },
      );
    }
  }

  return handler(req);
}

export {
  authedHandler as GET,
  authedHandler as POST,
  authedHandler as DELETE,
};
