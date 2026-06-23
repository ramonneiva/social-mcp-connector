# Tools

All tools return a text block containing a short summary line followed by a
fenced `json` payload. On error they return a single `❌ <message>` text block
with `isError: true` (the server never crashes on a tool error).

| Tool | Params | Returns |
| ---- | ------ | ------- |
| `instagram_account_overview` | _none_ | IG Business account: `id`, `username`, `name`, `biography`, `website`, `followers_count`, `follows_count`, `media_count`, `profile_picture_url`. |
| `instagram_account_insights` | `days?` (int, default 7, max 90), `since?` (unix sec or `YYYY-MM-DD`), `until?` (unix sec or `YYYY-MM-DD`), `metrics?` (CSV, default `reach,profile_views,follower_count`) | The requested IG insight metrics as a time series over the window, plus the resolved `{ since, until }` and `metric` used. |
| `instagram_recent_media` | `limit?` (1–25, default 10), `includeInsights?` (bool, default true) | Array of recent media with `caption`, `media_type`, `permalink`, `timestamp`, `like_count`, `comments_count`, and (when `includeInsights`) per-post `insights` (`reach`, `total_interactions`) or a per-post `insights_error`. |
| `facebook_page_insights` | `days?` (int, default 7, max 90), `since?`, `until?`, `metrics?` (CSV, default `page_impressions,page_post_engagements,page_views_total,page_fan_adds`) | `page` node (`id`, `name`, `followers_count` — `fan_count` is deprecated and no longer requested) plus each requested insight metric. Every metric is fetched independently; rejected/deprecated metrics are listed under `insight_errors` instead of failing the tool. |
| `tiktok_user_info` | _none_ | TikTok creator: `open_id`, `union_id`, `display_name`, `avatar_url`, `follower_count`, `following_count`, `likes_count`, `video_count`, `bio_description`, `profile_deep_link`. |
| `tiktok_recent_videos` | `maxCount?` (1–20, default 10) | `count`, `has_more`, `cursor`, and a `videos` array with `id`, `title`, `create_time`, `view_count`, `like_count`, `comment_count`, `share_count`, `share_url`, `duration`, `cover_image_url`. |
| `social_overview` | _none_ | Aggregated headline numbers: IG (`username`, `followers_count`, `media_count`), FB (`name`, `fan_count`, `followers_count`), TikTok (`display_name`, `follower_count`, `likes_count`, `video_count`). Platforms missing a token report an inline `error` instead of failing the whole call. |

## Instagram account id auto-resolution

The Instagram tools resolve the IG Business Account id robustly:

1. If `META_IG_USER_ID` is set, it is validated (an IG-only field is requested).
2. If it is missing, invalid, or actually a Page id, the id is **auto-derived**
   from `META_PAGE_ID` via `GET /{META_PAGE_ID}?fields=instagram_business_account{id,username}`.

The resolved id and its `ig_user_id_source` are included in each IG tool's output,
so you can see whether the configured id or the auto-derived one was used.

## Required env per tool

| Tool | Requires |
| ---- | -------- |
| `instagram_account_overview` | `META_ACCESS_TOKEN`, `META_IG_USER_ID` |
| `instagram_account_insights` | `META_ACCESS_TOKEN`, `META_IG_USER_ID` |
| `instagram_recent_media` | `META_ACCESS_TOKEN`, `META_IG_USER_ID` |
| `facebook_page_insights` | `META_ACCESS_TOKEN`, `META_PAGE_ID` |
| `tiktok_user_info` | `TIKTOK_ACCESS_TOKEN` |
| `tiktok_recent_videos` | `TIKTOK_ACCESS_TOKEN` |
| `social_overview` | Any/all of the above (uses whatever is configured) |

If a required variable is missing, the tool returns a clear message such as
`❌ META_ACCESS_TOKEN is not set. Add it to your environment / Vercel project settings.`
