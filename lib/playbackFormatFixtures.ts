// Preview-only fixture selection. These are existing public assets, matched to
// the read-only descriptors and completed byte audit; no media is generated.
export type PlaybackFormat = "original" | "mp4" | "hls";

const clips = [
  {
    id: "carlos", label: "Carlos",
    version: "sha256:1eb772bf1adb09390a6b6993ed85b44f68247d91a45b550523f900f55736af4a",
    original: "https://media.creatornet.net/videos/7cb02077-bcba-4c29-8f3c-f1584d1ed961/1790458342012.mp4",
    mp4: "https://media.creatornet.net/feed-auto/1eb772bf1adb09390a6b6993ed85b44f68247d91a45b550523f900f55736af4a.mp4",
    hls: "https://customer-emx4uma3h4ofg314.cloudflarestream.com/055c52cd11ab6482f3c4fdbc9336fb10/manifest/video.m3u8",
  },
  {
    id: "noah", label: "Noah",
    version: "sha256:d2c530f03d2bde9217da9f830ff964141be5843a7ba5afee9332fb708bdf49ee",
    original: "https://media.creatornet.net/videos/767658b6-7b2a-4cc4-91b4-6a0f78073a8e/1789953087942.mp4",
    mp4: "https://media.creatornet.net/feed-auto/d2c530f03d2bde9217da9f830ff964141be5843a7ba5afee9332fb708bdf49ee.mp4",
    hls: "https://customer-emx4uma3h4ofg314.cloudflarestream.com/50eed272e3d4283f18f4b67a03e04ae7/manifest/video.m3u8",
  },
] as const;

export function playbackFormatFixtures(format: PlaybackFormat) {
  return clips.map(clip => ({
    // Separate IDs/versions prevent a page format change from importing an
    // unverified cross-rendition return position from the shared singleton.
    id: `preview-format-${clip.id}-${format}`,
    label: clip.label,
    src: clip[format],
    contentVersion: `${clip.version}:${format}`,
  }));
}
