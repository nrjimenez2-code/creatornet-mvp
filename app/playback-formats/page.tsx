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

export default async function PlaybackFormatsPage({ searchParams }: { searchParams: Promise<{ format?: string | string[]; transfer?: string | string[] }> }) {
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const params = await searchParams;
  const format = params.format ?? "hls";
  if (format !== "original" && format !== "mp4" && format !== "hls") notFound();
  const transfer = params.transfer ?? "parked";
  if (transfer !== "parked" && transfer !== "direct" && transfer !== "prepared" && transfer !== "prepared-audio") notFound();
  // Keep this one-variable control on the measured processed-MP4 fixture pair.
  if (transfer !== "parked" && format !== "mp4") notFound();
  return <PlaybackLab key={`formats:${format}${transfer !== "parked" ? `:${transfer}` : ""}`} controllerMode={transfer === "prepared" || transfer === "prepared-audio" ? transfer : "steady"} sourceFormat={format}
    directMainTransfer={transfer === "direct"}
    fixtures={playbackFormatFixtures(format)} buildCommit={process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"} />;
}
