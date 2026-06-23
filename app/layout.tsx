import type { ReactNode } from 'react';

export const metadata = {
  title: 'Social MCP Connector',
  description:
    'Remote MCP server exposing Meta (Facebook + Instagram) and TikTok organic social data as MCP tools.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          margin: 0,
          background: '#0b0b0f',
          color: '#e8e8ed',
        }}
      >
        {children}
      </body>
    </html>
  );
}
