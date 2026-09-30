import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { playbackFormatFixtures } from "@/lib/playbackFormatFixtures";
import PlaybackLab from "../playback-lab/PlaybackLab";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Preview playback format comparison",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PlaybackFormatsPage({ searchParams }: { searchParams: Promise<{ format?: string | string[] }> }) {
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const format = (await searchParams).format ?? "hls";
  if (format !== "original" && format !== "mp4" && format !== "hls") notFound();
  return <PlaybackLab key={`formats:${format}`} controllerMode="steady" sourceFormat={format}
    fixtures={playbackFormatFixtures(format)} buildCommit={process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"} />;
}
