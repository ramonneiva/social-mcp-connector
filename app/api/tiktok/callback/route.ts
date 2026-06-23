import { tiktokRedirectUri, readCookie, escapeHtml, htmlPage } from '@/lib/http';

export const dynamic = 'force-dynamic';

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

/**
 * GET /api/tiktok/callback
 * Receives ?code=... from TikTok, exchanges it for tokens, and renders a page
 * showing the access_token / refresh_token / expires_in / open_id with copy
 * instructions. Never logs secrets.
 */
export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const oauthError = searchParams.get('error');
  const oauthErrorDesc =
    searchParams.get('error_description') || searchParams.get('error_message');

  // 1. TikTok returned an error (e.g. user denied, scope not approved).
  if (oauthError) {
    return htmlPage(
      'TikTok authorization failed',
      `<h1 class="err">❌ TikTok authorization failed</h1>
       <div class="field"><span class="label">error</span><span class="v">${escapeHtml(
         oauthError,
       )}</span></div>
       <div class="field"><span class="label">description</span><span class="v">${escapeHtml(
         oauthErrorDesc || '(none provided)',
       )}</span></div>
       <p class="muted">Common causes: the requested scopes are not approved for your app,
       the account is not added as a target user in Sandbox mode, or the redirect URI does not
       match the one registered in the TikTok app. Fix and try
       <a href="/api/tiktok/auth">/api/tiktok/auth</a> again.</p>`,
      400,
    );
  }

  if (!code) {
    return htmlPage(
      'TikTok callback — missing code',
      `<h1 class="err">❌ Missing authorization code</h1>
       <p class="muted">No <code>code</code> parameter was provided. Start the flow at
       <a href="/api/tiktok/auth">/api/tiktok/auth</a>.</p>`,
      400,
    );
  }

  // 2. CSRF state check (soft: only fail on an explicit mismatch).
  const expectedState = readCookie(req, 'tiktok_oauth_state');
  if (expectedState && state && expectedState !== state) {
    return htmlPage(
      'TikTok callback — state mismatch',
      `<h1 class="err">❌ State mismatch</h1>
       <p class="muted">The <code>state</code> returned by TikTok did not match the one issued
       at the start of the flow. This can be a CSRF attempt or simply an expired session.
       Restart at <a href="/api/tiktok/auth">/api/tiktok/auth</a>.</p>`,
      400,
    );
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret) {
    return htmlPage(
      'TikTok callback — missing app credentials',
      `<h1 class="err">❌ Server not configured</h1>
       <p class="muted">${escapeHtml(
         !clientKey ? 'TIKTOK_CLIENT_KEY' : 'TIKTOK_CLIENT_SECRET',
       )} is not set. Add the TikTok app credentials to the Vercel env vars and redeploy.</p>`,
      500,
    );
  }

  // 3. Exchange the code for tokens.
  const redirectUri = tiktokRedirectUri(req);
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  let data: any;
  try {
    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    data = await res.json().catch(() => ({}));
  } catch (e: any) {
    return htmlPage(
      'TikTok token exchange failed',
      `<h1 class="err">❌ Token exchange request failed</h1>
       <div class="field"><span class="v">${escapeHtml(e?.message || String(e))}</span></div>`,
      502,
    );
  }

  // TikTok error shape: { error, error_description, log_id } (or nested).
  const errCode = data?.error || data?.error_code;
  if (errCode || !data?.access_token) {
    return htmlPage(
      'TikTok token exchange error',
      `<h1 class="err">❌ Could not obtain an access token</h1>
       <div class="field"><span class="label">error</span><span class="v">${escapeHtml(
         errCode || 'no access_token returned',
       )}</span></div>
       <div class="field"><span class="label">description</span><span class="v">${escapeHtml(
         data?.error_description || '(none)',
       )}</span></div>
       ${
         data?.log_id
           ? `<div class="field"><span class="label">log_id</span><span class="v">${escapeHtml(
               data.log_id,
             )}</span></div>`
           : ''
       }
       <p class="muted">Check that the redirect URI matches exactly, that the scopes are approved,
       and (Sandbox) that your TikTok account is added as a target user. Retry at
       <a href="/api/tiktok/auth">/api/tiktok/auth</a>.</p>`,
      400,
    );
  }

  // 4. Success — render the tokens with copy instructions.
  const accessToken = escapeHtml(data.access_token);
  const refreshToken = escapeHtml(data.refresh_token);
  const expiresIn = escapeHtml(data.expires_in);
  const refreshExpiresIn = escapeHtml(data.refresh_expires_in);
  const openId = escapeHtml(data.open_id);
  const scope = escapeHtml(data.scope);

  return htmlPage(
    'TikTok access token',
    `<h1 class="ok">✅ TikTok access token generated</h1>
     <p class="muted">Copy the <strong>access_token</strong> below into your Vercel project as
     <code>TIKTOK_ACCESS_TOKEN</code>, then redeploy. These values are shown once here and are
     not stored or logged by this server.</p>

     <h2>access_token <span class="muted">→ set as TIKTOK_ACCESS_TOKEN</span></h2>
     <div class="field"><span class="v">${accessToken}</span></div>

     <h2>refresh_token <span class="muted">(keep safe — used to renew the access token)</span></h2>
     <div class="field"><span class="v">${refreshToken}</span></div>

     <h2>Details</h2>
     <div class="field"><span class="label">open_id</span><span class="v">${openId}</span></div>
     <div class="field"><span class="label">expires_in (seconds)</span><span class="v">${expiresIn}</span></div>
     <div class="field"><span class="label">refresh_expires_in (seconds)</span><span class="v">${refreshExpiresIn}</span></div>
     <div class="field"><span class="label">scope</span><span class="v">${scope}</span></div>

     <h2>Next steps</h2>
     <ol class="muted">
       <li>Vercel → Project → <strong>Settings → Environment Variables</strong>.</li>
       <li>Add/Update <code>TIKTOK_ACCESS_TOKEN</code> with the access_token above (Production).</li>
       <li>Redeploy (Deployments → ⋯ → Redeploy, or push a commit).</li>
       <li>The <code>tiktok_user_info</code> and <code>tiktok_recent_videos</code> tools will then return live data.</li>
     </ol>
     <p class="muted">Note: the access token expires after <code>expires_in</code> seconds. Use the
     refresh_token with TikTok's <code>/v2/oauth/token/</code> (grant_type=refresh_token) to mint a new one.</p>`,
  );
}
