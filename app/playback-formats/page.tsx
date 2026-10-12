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

export default async function PlaybackFormatsPage({ searchParams }: { searchParams: Promise<{ format?: string | string[]; transfer?: string | string[]; feedReadout?: string | string[]; retire?: string | string[]; noahSource?: string | string[] }> }) {
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const params = await searchParams;
  const format = params.format ?? "hls";
  if (format !== "original" && format !== "mp4" && format !== "hls") notFound();
  const transfer = params.transfer ?? "parked";
  if (transfer !== "parked" && transfer !== "direct" && transfer !== "prepared" && transfer !== "prepared-audio" && transfer !== "prepared-inplace-audio" && transfer !== "prepared-preload-audio") notFound();
  // Keep this one-variable control on the measured processed-MP4 fixture pair.
  if (transfer !== "parked" && format !== "mp4") notFound();
  // Reuse the audited original only for the unresolved paused-start boundary.
  // Carlos and every playback/lifecycle setting remain the processed baseline.
  const originalNoahStartup = params.noahSource === "original";
  if (params.noahSource !== undefined && (!originalNoahStartup || transfer !== "prepared-preload-audio" || format !== "mp4" || params.retire !== undefined)) notFound();
  const deferPreparedRetirement = params.retire === "after-startup";
  if (params.retire !== undefined && (params.retire !== "after-startup" || transfer !== "prepared-preload-audio" || format !== "mp4")) notFound();
  const liveReadout = !(transfer === "prepared-preload-audio" && format === "mp4" && params.feedReadout === "0");
  const fixtures = playbackFormatFixtures(format);
  if (originalNoahStartup) fixtures[1] = playbackFormatFixtures("original")[1];
  return <PlaybackLab key={`formats:${format}${transfer !== "parked" ? `:${transfer}` : ""}${deferPreparedRetirement ? ":retire-after-startup" : ""}${originalNoahStartup ? ":noah-original" : ""}`} controllerMode={transfer === "prepared" || transfer === "prepared-audio" || transfer === "prepared-inplace-audio" || transfer === "prepared-preload-audio" ? transfer : "steady"} sourceFormat={format}
    directMainTransfer={transfer === "direct"} liveReadout={liveReadout} deferPreparedRetirement={deferPreparedRetirement}
    originalNoahStartup={originalNoahStartup} fixtures={fixtures} buildCommit={process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"} />;
}
