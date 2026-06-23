import { randomUUID } from 'crypto';
import { tiktokRedirectUri } from '@/lib/http';

export const dynamic = 'force-dynamic';

const TIKTOK_AUTHORIZE_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';

/**
 * GET /api/tiktok/auth
 * Builds the TikTok Login Kit authorize URL and 302-redirects the browser to it.
 */
export async function GET(req: Request): Promise<Response> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  if (!clientKey) {
    return new Response(
      'TIKTOK_CLIENT_KEY is not set. Add it to your Vercel project env vars (it comes from the TikTok developer portal) and redeploy.',
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const redirectUri = tiktokRedirectUri(req);
  const state = randomUUID();

  const authorize = new URL(TIKTOK_AUTHORIZE_BASE);
  authorize.searchParams.set('client_key', clientKey);
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('state', state);

  // Store state in an httpOnly cookie so the callback can verify it (CSRF guard).
  const cookie = [
    `tiktok_oauth_state=${state}`,
    'Path=/api/tiktok',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}
