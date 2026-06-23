import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';

import {
  getInstagramOverview,
  getInstagramInsights,
  getInstagramRecentMedia,
  getFacebookPageInsights,
  type ToolResult,
} from '@/lib/meta';
import { getTikTokUserInfo, getTikTokRecentVideos } from '@/lib/tiktok';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ── MCP content helpers ──────────────────────────────────────────────────────
type McpResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(summary: string, data: unknown): McpResult {
  const text = `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: 'text', text }] };
}

function fail(message: string): McpResult {
  return { content: [{ type: 'text', text: `❌ ${message}` }], isError: true };
}

/** Run a lib function and map its normalised result into an MCP result. */
async function run(summary: string, fn: () => Promise<ToolResult>): Promise<McpResult> {
  try {
    const r = await fn();
    if (!r.ok) return fail(r.error ?? 'Unknown error');
    return ok(summary, r.data);
  } catch (e: any) {
    // Defensive: a single tool error must never crash the server.
    return fail(`Unexpected error: ${e?.message || String(e)}`);
  }
}

// ── MCP handler ──────────────────────────────────────────────────────────────
const handler = createMcpHandler(
  (server) => {
    // ── Instagram ────────────────────────────────────────────────────────────
    server.tool(
      'instagram_account_overview',
      'Instagram Business/Creator account profile: username, name, followers_count, follows_count, media_count, biography, profile picture. Requires META_ACCESS_TOKEN and META_IG_USER_ID.',
      {},
      async () => run('Instagram account overview', getInstagramOverview),
    );

    server.tool(
      'instagram_account_insights',
      'Instagram account insights (reach, profile_views, follower_count, etc.) over a time window. Defaults to the last 7 days. Requires META_ACCESS_TOKEN and META_IG_USER_ID.',
      {
        days: z
          .number()
          .int()
          .positive()
          .max(90)
          .optional()
          .describe('Number of days back from now (default 7). Ignored if `since`/`until` given.'),
        since: z
          .string()
          .optional()
          .describe('Start of window: unix seconds or YYYY-MM-DD.'),
        until: z
          .string()
          .optional()
          .describe('End of window: unix seconds or YYYY-MM-DD (default now).'),
        metrics: z
          .string()
          .optional()
          .describe('Comma-separated metric list. Default "reach,profile_views,follower_count".'),
      },
      async (args) => run('Instagram account insights', () => getInstagramInsights(args)),
    );

    server.tool(
      'instagram_recent_media',
      'Recent Instagram posts with per-post metrics (like_count, comments_count, reach, total_interactions). Requires META_ACCESS_TOKEN and META_IG_USER_ID.',
      {
        limit: z
          .number()
          .int()
          .positive()
          .max(25)
          .optional()
          .describe('How many recent media to return (1-25, default 10).'),
        includeInsights: z
          .boolean()
          .optional()
          .describe('Fetch per-post reach/interactions insights (default true).'),
      },
      async (args) => run('Instagram recent media', () => getInstagramRecentMedia(args)),
    );

    // ── Facebook Page ────────────────────────────────────────────────────────
    server.tool(
      'facebook_page_insights',
      'Facebook Page insights: followers_count plus page_impressions, page_post_engagements, page_views_total, page_fan_adds over a time window (default last 7 days). Each metric is requested independently, so a deprecated/invalid metric is skipped (reported under insight_errors) rather than failing the tool. Requires META_ACCESS_TOKEN and META_PAGE_ID.',
      {
        days: z.number().int().positive().max(90).optional().describe('Days back from now (default 7).'),
        since: z.string().optional().describe('Start: unix seconds or YYYY-MM-DD.'),
        until: z.string().optional().describe('End: unix seconds or YYYY-MM-DD (default now).'),
        metrics: z
          .string()
          .optional()
          .describe('Comma-separated metrics. Default "page_impressions,page_post_engagements,page_views_total,page_fan_adds".'),
      },
      async (args) => run('Facebook Page insights', () => getFacebookPageInsights(args)),
    );

    // ── TikTok ───────────────────────────────────────────────────────────────
    server.tool(
      'tiktok_user_info',
      'TikTok creator account info: open_id, display_name, follower_count, following_count, likes_count, video_count. Requires TIKTOK_ACCESS_TOKEN.',
      {},
      async () => run('TikTok user info', getTikTokUserInfo),
    );

    server.tool(
      'tiktok_recent_videos',
      'Recent TikTok videos with view_count, like_count, comment_count, share_count. Requires TIKTOK_ACCESS_TOKEN.',
      {
        maxCount: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe('How many recent videos to return (1-20, default 10).'),
      },
      async (args) => run('TikTok recent videos', () => getTikTokRecentVideos(args)),
    );

    // ── Aggregate ────────────────────────────────────────────────────────────
    server.tool(
      'social_overview',
      'Convenience tool: aggregates headline numbers across Instagram, Facebook Page, and TikTok into a single snapshot. Returns whatever platforms have valid tokens; per-platform errors are reported inline.',
      {},
      async () => {
        // These lib functions never throw — they always resolve to ToolResult.
        const [ig, fb, tt] = await Promise.all([
          getInstagramOverview(),
          getFacebookPageInsights({ days: 7 }),
          getTikTokUserInfo(),
        ]);

        const summary = {
          instagram: ig.ok
            ? {
                username: (ig.data as any)?.username,
                followers_count: (ig.data as any)?.followers_count,
                media_count: (ig.data as any)?.media_count,
              }
            : { error: (ig as any).error },
          facebook: fb.ok
            ? {
                name: (fb.data as any)?.page?.name,
                followers_count: (fb.data as any)?.page?.followers_count,
              }
            : { error: (fb as any).error },
          tiktok: tt.ok
            ? {
                display_name: (tt.data as any)?.display_name,
                follower_count: (tt.data as any)?.follower_count,
                likes_count: (tt.data as any)?.likes_count,
                video_count: (tt.data as any)?.video_count,
              }
            : { error: (tt as any).error },
        };

        return ok('Social overview (Instagram + Facebook + TikTok)', summary);
      },
    );
  },
  {
    // Server capabilities / metadata
    serverInfo: {
      name: 'social-mcp-connector',
      version: '1.0.0',
    },
  },
  {
    // Adapter config — basePath "/api" => /api/mcp (Streamable HTTP) and /api/sse (SSE).
    basePath: '/api',
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== 'production',
    // Redis is OPTIONAL: only enables SSE resumability. Streamable HTTP works without it.
    redisUrl: process.env.REDIS_URL || undefined,
  },
);

// ── Optional shared-secret bearer auth ───────────────────────────────────────
async function authedHandler(req: Request): Promise<Response> {
  const required = process.env.MCP_AUTH_TOKEN;
  if (required && required.trim()) {
    const header = req.headers.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (token !== required.trim()) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' },
          id: null,
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
  }
  return handler(req);
}

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
