# Social MCP Connector

A **remote [Model Context Protocol](https://modelcontextprotocol.io) server** that
exposes your **Meta (Facebook + Instagram)** and **TikTok** organic social data as
MCP tools, so you can ask Claude Desktop or ChatGPT things like *"how did my
Instagram account grow this week?"* or *"list my latest TikToks with their view
counts."*

It hits the **live** Meta Graph API and TikTok Display API using access tokens you
provide as environment variables — there is **no mock data**.

- **Transport:** Streamable HTTP + SSE via the Vercel [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) adapter (`@vercel/mcp-adapter`).
- **Stack:** Next.js (App Router) + TypeScript, deploys to Vercel.
- **Endpoint:** a single route handler at `app/api/[transport]/route.ts`.

## Connector URLs

Once deployed to `https://<your-app>.vercel.app`:

| Transport | URL |
| --------- | --- |
| **Streamable HTTP** (recommended) | `https://<your-app>.vercel.app/api/mcp` |
| **SSE** (legacy clients) | `https://<your-app>.vercel.app/api/sse` |

> SSE resumability across serverless invocations needs Redis. It is **optional** —
> leave `REDIS_URL` unset and the Streamable HTTP path (`/api/mcp`) works fully
> without it.

### TikTok OAuth helper endpoints

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/tiktok/auth` | Redirects to TikTok to authorize and generate a token. |
| `GET /api/tiktok/callback` | Shows the resulting `TIKTOK_ACCESS_TOKEN` to copy into Vercel. |

Start here to get your token: `https://<your-app>.vercel.app/api/tiktok/auth`

## Tools

See [`tools.md`](./tools.md) for full parameter and return details.

| Tool | What it does |
| ---- | ------------ |
| `instagram_account_overview` | IG followers, media count, name, bio, profile picture |
| `instagram_account_insights` | IG reach, profile views, follower growth over a period |
| `instagram_recent_media` | Recent IG posts with per-post likes / comments / reach |
| `facebook_page_insights` | FB Page impressions, post engagements, fan count |
| `tiktok_user_info` | TikTok followers, following, likes, video count |
| `tiktok_recent_videos` | Recent TikTok videos with views / likes / comments / shares |
| `social_overview` | Aggregated headline numbers across IG + FB + TikTok |

## Environment variables

Copy [`.env.example`](./.env.example) to `.env.local` for local dev, or set these in
**Vercel → Project → Settings → Environment Variables**.

| Variable | Required? | Description |
| -------- | --------- | ----------- |
| `META_ACCESS_TOKEN` | for Meta/IG tools | **Long-lived** Meta access token with the permissions below. |
| `META_IG_USER_ID` | for IG tools | Instagram **Business/Creator** account id (numeric, not the `@handle`). |
| `META_PAGE_ID` | for FB tool | Facebook **Page** id linked to the IG account. |
| `META_APP_ID` | optional | App id — only for token debugging / `appsecret_proof`. |
| `META_APP_SECRET` | optional | App secret — only for token debugging / `appsecret_proof`. |
| `TIKTOK_ACCESS_TOKEN` | for TikTok tools | User access token from TikTok Login Kit OAuth. |
| `TIKTOK_CLIENT_KEY` | for OAuth helper | TikTok app client key. Used by `/api/tiktok/auth` to mint the access token. |
| `TIKTOK_CLIENT_SECRET` | for OAuth helper | TikTok app client secret. Used by `/api/tiktok/callback` for the token exchange. |
| `TIKTOK_REDIRECT_URI` | optional | Override the OAuth redirect URI. Defaults to `${origin}/api/tiktok/callback`. Must match the URI registered in the TikTok app. |
| `MCP_AUTH_TOKEN` | optional | If set, the MCP endpoint requires `Authorization: Bearer <value>`. If unset, the endpoint is **open**. |
| `REDIS_URL` | optional | Enables SSE resumability. Not needed for Streamable HTTP. |

> **The build never reads tokens.** `npm run build` makes no API calls and passes
> with no env vars set; tokens are only used at request time.

### Meta prerequisites

1. An Instagram **Business or Creator** account, **linked to a Facebook Page**.
2. A Meta app with these permissions granted on the token:
   `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`,
   `pages_show_list`, `read_insights` (and `business_management` if using a
   Business portfolio).
3. A **long-lived** token (short-lived tokens expire in ~1 hour). Exchange via:
   `GET https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_LIVED_TOKEN>`
4. **You usually only need `META_ACCESS_TOKEN`.** The server auto-discovers the
   rest: it calls `GET /me/accounts` to find the Page you manage (and its
   **Page access token**, which Page insights require) and the linked Instagram
   Business account id. `META_PAGE_ID` / `META_IG_USER_ID` are optional overrides —
   if set and valid they win; if missing or wrong they are auto-resolved. Each
   tool's output reports which id was used and its `source` (env vs discovered).
   To set them explicitly:
   `GET https://graph.facebook.com/v21.0/me/accounts?access_token=<TOKEN>` (Page id),
   then `GET https://graph.facebook.com/v21.0/<PAGE_ID>?fields=instagram_business_account&access_token=<TOKEN>` (IG user id).

### TikTok prerequisites

The TikTok portal only gives you a **Client Key + Client Secret** — the access
token must come from the Login Kit OAuth flow. This app includes a helper to do
that for you:

1. A TikTok developer app with **Login Kit** and the **Display API** enabled.
2. Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` in Vercel (+ optionally
   `TIKTOK_REDIRECT_URI`) and deploy.
3. In your TikTok app, register the **Redirect URI**:
   `https://social-mcp-connector.vercel.app/api/tiktok/callback`
   (it must match exactly — including https and no trailing slash differences).
4. Add the scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`,
   `video.list`.
5. **Sandbox mode:** add your TikTok account as a **target user** in the app's
   sandbox, otherwise authorization fails with a scope/permission error.
6. Visit **`https://social-mcp-connector.vercel.app/api/tiktok/auth`** in a
   browser. It redirects you to TikTok to authorize, then the callback page
   displays your `access_token`, `refresh_token`, `expires_in`, and `open_id`.
7. Copy the `access_token` into Vercel as `TIKTOK_ACCESS_TOKEN` and redeploy.

> The OAuth helper never logs or stores tokens — it only renders them once on the
> callback page for you to copy.

## Deploy to Vercel

1. Push this repo to GitHub (already done if you cloned it from `davolu`).
2. In Vercel, **Add New → Project** and import the repo. Framework preset:
   **Next.js** (auto-detected). No build settings to change.
3. Add the environment variables above under **Settings → Environment Variables**
   (Production + Preview).
4. **Deploy.** Your MCP endpoints are then:
   - `https://<your-app>.vercel.app/api/mcp`
   - `https://<your-app>.vercel.app/api/sse`

Local dev (optional): `npm install` then `npm run dev` (do **not** commit `.env.local`).

## Add the connector in Claude Desktop

1. Open **Claude Desktop → Settings → Connectors**.
2. Click **Add custom connector**.
3. **Name:** `Social MCP` (anything).
4. **URL:** paste your Streamable HTTP endpoint:
   `https://<your-app>.vercel.app/api/mcp`
5. If you set `MCP_AUTH_TOKEN`, add an **Authorization** header with the value
   `Bearer <your-MCP_AUTH_TOKEN>` (in Claude Desktop's connector auth field, or
   the OAuth/headers section). If `MCP_AUTH_TOKEN` is unset, leave auth empty.
6. **Save / Connect.** The seven tools above will appear and you can start asking
   questions like *"Give me a social_overview"* or *"Show my recent Instagram media."*

> **ChatGPT:** use **Settings → Connectors → Create / Add custom connector** and
> paste the same `/api/mcp` URL (plus the bearer token if configured).

## Robustness notes

- Every tool checks for its required token first and returns a clear message
  (e.g. `❌ TIKTOK_ACCESS_TOKEN is not set...`) rather than throwing.
- A small fetch helper (`lib/fetcher.ts`) adds a 20s timeout and normalises Meta
  and TikTok API error shapes (expired token, missing permission, rate limit)
  into readable messages.
- A single tool/API failure never crashes the server; `social_overview` returns
  partial results with per-platform errors inline.

## Security

- Tokens are read from server-side env vars only and are never sent to the
  browser or included in responses.
- `.env*` is git-ignored (except `.env.example`); **no secrets are committed**.
- Set `MCP_AUTH_TOKEN` to require a shared-secret bearer token on the endpoint.
