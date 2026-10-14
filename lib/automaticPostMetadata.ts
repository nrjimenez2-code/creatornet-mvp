import { extractHashtags } from "@/lib/hashtags";
import { INTEREST_CATEGORIES, type InterestCategory } from "@/lib/interestCategories";
import { matchInterestTopics, normalizeTopic, normalizeTopics } from "@/lib/interestTopics";

export const AUTOMATIC_POST_CLASSIFICATION_VERSION = 1;

/** Context comes from the server's verified post, profile and linked offer reads. */
export type PostClassificationContext = {
  title?: string | null;
  content?: string | null;
  caption?: string | null;
  bio?: string | null;
  tagline?: string | null;
  offers?: { title?: string | null; description?: string | null }[];
};
export type VideoEvidence = {
  kind: "speech" | "screen_text" | "visual";
  text: string;
  start_seconds?: number;
  end_seconds?: number;
};
export type VideoLabel = { category: InterestCategory; topics: string[]; evidence: VideoEvidence[] };
export type VideoUnderstanding = {
  transcript: string;
  screen_text: string;
  visual_summary: string;
  labels: VideoLabel[];
};

/** Creator hashtags are never synthesized from inferred labels. Ranking stays unchanged. */
export function automaticPostMetadata(context: PostClassificationContext, video?: VideoUnderstanding) {
  const hashtags = extractHashtags([context.content, context.caption].filter(Boolean).join(" "));
  const direct = matchInterestTopics({
    title: context.title,
    description: [context.content, context.caption].filter(Boolean).join(" "),
    topics: hashtags,
    offers: context.offers,
  });
  const combined = matchInterestTopics({
    interests: [...direct.categories, ...(video?.labels.map(label => label.category) ?? [])],
    topics: [...direct.topics, ...(video?.labels.flatMap(label => label.topics) ?? [])],
  });
  if (combined.categories.length) return {
    interests: combined.categories, topics: normalizeTopics(combined.topics), hashtags,
    source: video?.labels.length ? "text_and_video" : "text",
  };
  const fallback = matchInterestTopics({ description: [context.bio, context.tagline].filter(Boolean).join(" ") });
  return {
    interests: fallback.categories, topics: normalizeTopics([...combined.topics, ...fallback.topics]), hashtags,
    source: fallback.categories.length ? "profile_fallback" : "unclassified",
  };
}

/** Validate provider data before it can reach stored labels; quotes must exist in the extraction. */
export function parseVideoUnderstanding(raw: string, durationSeconds: number | null = null): VideoUnderstanding {
  let data: VideoUnderstanding;
  try { data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
  catch { throw new Error("invalid_extraction"); }
  const invalid = () => { throw new Error("invalid_extraction"); };
  if (!data || typeof data.transcript !== "string" || data.transcript.length > 60000 ||
      typeof data.screen_text !== "string" || data.screen_text.length > 20000 ||
      typeof data.visual_summary !== "string" || data.visual_summary.length > 4000 ||
      !Array.isArray(data.labels) || data.labels.length > 8) return invalid();
  const labels: VideoLabel[] = data.labels.map(label => {
    if (!label || !INTEREST_CATEGORIES.includes(label.category) || !Array.isArray(label.topics) ||
        label.topics.length > 20 || label.topics.some(topic => !normalizeTopic(topic)) ||
        !Array.isArray(label.evidence) || !label.evidence.length || label.evidence.length > 10) return invalid();
    const evidence = label.evidence.map(item => {
      if (!item || !["speech", "screen_text", "visual"].includes(item.kind) ||
          typeof item.text !== "string" || !item.text.trim() || item.text.length > 2000) return invalid();
      if (item.kind !== "visual") {
        const source = item.kind === "speech" ? data.transcript : data.screen_text;
        if (!source.includes(item.text)) return invalid();
        return { kind: item.kind, text: item.text };
      }
      const start = item.start_seconds, end = item.end_seconds;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) ||
          !Number.isFinite(end) || start < 0 || end < start || end > (durationSeconds ?? 600)) return invalid();
      return { kind: item.kind, text: item.text, start_seconds: start, end_seconds: end };
    });
    // Use the existing canonical topic names where a submitted term matches one.
    const topics = label.topics.flatMap(topic => {
      const matched = matchInterestTopics({ description: topic });
      return matched.topics.length ? matched.topics : [normalizeTopic(topic)!];
    });
    return { category: label.category, topics: normalizeTopics(topics), evidence };
  });
  return { transcript: data.transcript.trim(), screen_text: data.screen_text.trim(),
    visual_summary: data.visual_summary.trim(), labels };
}
