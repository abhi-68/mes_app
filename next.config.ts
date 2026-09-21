import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev badge overlaps shop-floor UI in screenshots and on tablets.
  devIndicators: false,
};

export default nextConfig;
