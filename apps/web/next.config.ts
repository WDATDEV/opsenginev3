import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["html5-qrcode"],
  async redirects() {
    // The floor phone and QR gate became one check-in station.
    return ["/warehouse", "/phone", "/gate"].map((source) => ({ source, destination: "/station", permanent: false }));
  },
};

export default nextConfig;
