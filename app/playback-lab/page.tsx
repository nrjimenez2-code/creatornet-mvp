import type { Metadata } from "next";
import { notFound } from "next/navigation";
import adaptiveManifest from "@/lib/feedAdaptiveManifest.json";
import PlaybackLab from "./PlaybackLab";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Preview HLS controller lab",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PlaybackLabPage({ searchParams }: { searchParams: Promise<{ mode?: string | string[] }> }) {
  // Fail closed on Production, local development, and unset deployment context.
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const requestedMode = (await searchParams).mode ?? "current";
  if (requestedMode !== "current" && requestedMode !== "rate") notFound();
  const fixtures = Object.entries(adaptiveManifest).map(([path, src], index) => ({
    id: `preview-hls-${index + 1}`,
    label: `HLS clip ${index + 1}`,
    src,
    contentVersion: path,
  }));
  return <PlaybackLab key={requestedMode} controllerMode={requestedMode} fixtures={fixtures} buildCommit={process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"} />;
}
