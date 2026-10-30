import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["html5-qrcode"],
  async redirects() {
    return [{ source: "/warehouse", destination: "/phone", permanent: true }];
  },
};

export default nextConfig;
