import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  async redirects() {
    return [
      {
        source: "/",
        destination: "/auth",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
