/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP route handler is fully dynamic (reads env + headers at request time).
  // Nothing here needs API tokens at build time.
  reactStrictMode: true,
};

export default nextConfig;
