/**
 * TikTok Display API helpers.
 *
 * Auth is via a user access token (TIKTOK_ACCESS_TOKEN) obtained through the
 * TikTok Login Kit OAuth flow. Functions return a normalised
 * `{ ok, data?, error? }` result and never throw.
 */

import { fetchJson } from './fetcher';
import type { ToolResult } from './meta';

export const TIKTOK_BASE = 'https://open.tiktokapis.com/v2';

function requireToken(): { value?: string; error?: string } {
  const value = process.env.TIKTOK_ACCESS_TOKEN;
  if (!value || !value.trim()) {
    return {
      error:
        'TIKTOK_ACCESS_TOKEN is not set. Add it to your environment / Vercel project settings.',
    };
  }
  return { value: value.trim() };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function getTikTokUserInfo(): Promise<ToolResult> {
  const token = requireToken();
  if (token.error) return { ok: false, error: token.error };

  const fields = [
    'open_id',
    'union_id',
    'display_name',
    'avatar_url',
    'follower_count',
    'following_count',
    'likes_count',
    'video_count',
    'bio_description',
    'profile_deep_link',
  ].join(',');

  const url = `${TIKTOK_BASE}/user/info/?fields=${encodeURIComponent(fields)}`;
  const res = await fetchJson(url, { method: 'GET', headers: authHeaders(token.value!) });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data?.data?.user ?? res.data };
}

export async function getTikTokRecentVideos(opts: { maxCount?: number }): Promise<ToolResult> {
  const token = requireToken();
  if (token.error) return { ok: false, error: token.error };

  const maxCount = Math.min(Math.max(opts.maxCount ?? 10, 1), 20);
  const fields = [
    'id',
    'title',
    'video_description',
    'create_time',
    'cover_image_url',
    'share_url',
    'duration',
    'view_count',
    'like_count',
    'comment_count',
    'share_count',
  ].join(',');

  const url = `${TIKTOK_BASE}/video/list/?fields=${encodeURIComponent(fields)}`;
  const res = await fetchJson(url, {
    method: 'POST',
    headers: authHeaders(token.value!),
    body: JSON.stringify({ max_count: maxCount }),
  });
  if (!res.ok) return { ok: false, error: res.error };

  const videos: any[] = res.data?.data?.videos ?? [];
  return {
    ok: true,
    data: {
      count: videos.length,
      has_more: res.data?.data?.has_more ?? false,
      cursor: res.data?.data?.cursor ?? null,
      videos,
    },
  };
}
