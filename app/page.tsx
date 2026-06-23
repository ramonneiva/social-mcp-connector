const TOOLS = [
  ['instagram_account_overview', 'IG followers, media count, name, bio, profile picture'],
  ['instagram_account_insights', 'IG reach, profile views, follower growth over a period'],
  ['instagram_recent_media', 'Recent IG posts with per-post likes / comments / reach'],
  ['facebook_page_insights', 'FB Page impressions, post engagements, fan count'],
  ['tiktok_user_info', 'TikTok followers, following, likes, video count'],
  ['tiktok_recent_videos', 'Recent TikTok videos with views / likes / comments / shares'],
  ['social_overview', 'Aggregated headline numbers across IG + FB + TikTok'],
];

export default function Home() {
  const card: React.CSSProperties = {
    maxWidth: 760,
    margin: '0 auto',
    padding: '48px 24px',
  };
  const code: React.CSSProperties = {
    background: '#1b1b24',
    padding: '2px 8px',
    borderRadius: 6,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 14,
  };

  return (
    <main style={card}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Social MCP Connector</h1>
      <p style={{ color: '#9a9aa6', marginTop: 0 }}>
        A remote Model Context Protocol server for Meta (Facebook + Instagram) and TikTok
        organic social data.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Connector endpoints</h2>
      <ul style={{ lineHeight: 1.9 }}>
        <li>
          Streamable HTTP: <span style={code}>/api/mcp</span>
        </li>
        <li>
          SSE: <span style={code}>/api/sse</span>
        </li>
      </ul>
      <p style={{ color: '#9a9aa6' }}>
        Add the full URL (e.g. <span style={code}>https://your-app.vercel.app/api/mcp</span>) as a
        custom connector in Claude Desktop or ChatGPT. See the README for exact steps.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Tools</h2>
      <ul style={{ lineHeight: 1.9 }}>
        {TOOLS.map(([name, desc]) => (
          <li key={name}>
            <span style={code}>{name}</span> — {desc}
          </li>
        ))}
      </ul>

      <p style={{ color: '#6b6b76', marginTop: 40, fontSize: 13 }}>
        This page is informational only. Tokens are read from server-side environment variables and
        never exposed to the browser.
      </p>
    </main>
  );
}
