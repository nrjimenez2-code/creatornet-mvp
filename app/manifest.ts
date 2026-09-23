import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CreatorNet",
    short_name: "CreatorNet",
    description:
      "Short-form video from creators who teach. Watch, follow, and buy their products, courses, and 1-on-1 calls.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/creatornet-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/creatornet-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
