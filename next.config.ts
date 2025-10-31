import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ✅ allows your phone to access the local dev server
  experimental: {
    ...( { allowedDevOrigins: ["http://192.168.0.2:3000"] } as any ),
  },

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
