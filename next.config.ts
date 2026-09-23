import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev badge overlaps shop-floor UI in screenshots and on tablets.
  devIndicators: false,
  experimental: {
    // Drawings arrive as server actions and a GA drawing is not 1 MB, which is
    // the default ceiling. The server rejects anything over 8 MB itself, with a
    // sentence a person can act on rather than this limit's opaque failure.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
