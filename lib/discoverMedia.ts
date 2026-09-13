import "server-only";

// Only the media processor can publish duration; browser-controlled metadata is
// insufficient to award completion. Unknown and legacy sources keep view tracking.
export async function verifiedVideoDuration(
  raw: unknown,
): Promise<number | null> {
  if (typeof raw !== "string") return null;
  try {
    const source = new URL(raw);
    if (
      source.origin !== "https://media.creatornet.net" ||
      source.username ||
      source.password ||
      source.search
    )
      return null;
    const key = source.pathname.replace(/^\/(?:auto\/)?/, "");
    if (
      !/^videos\/[a-zA-Z0-9_/-]+\.(mp4|mov|webm|m4v|mpeg|mpg|3gp|mkv)$/i.test(
        key,
      ) ||
      key.includes("..")
    )
      return null;
    const response = await fetch(
      `https://media.creatornet.net/auto/metadata/${key}`,
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) return null;
    const metadata = await response.json();
    return metadata.key === key &&
      typeof metadata.etag === "string" &&
      Number.isFinite(metadata.durationSeconds) &&
      metadata.durationSeconds > 0 &&
      metadata.durationSeconds <= 43200
      ? metadata.durationSeconds
      : null;
  } catch {
    return null;
  }
}
