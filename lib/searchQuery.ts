/** Shared query interpretation. Learning interests are deliberately not search evidence. */
const TOPICS = [
  { name: "ecommerce", aliases: ["e-commerce", "e commerce", "ecom", "ecommerce"], related: ["dropshipping", "online store", "shopify"] },
  { name: "dropshipping", aliases: ["drop shipping", "drop-shipping", "dropshipping"], related: ["ecommerce"] },
  { name: "seo", aliases: ["search engine optimization", "search engine optimisation", "seo"], related: ["digital marketing"] },
  { name: "ai", aliases: ["artificial intelligence", "ai"], related: ["machine learning", "automation"] },
  { name: "ugc", aliases: ["user generated content", "user-generated content", "ugc"], related: ["content creation"] },
  { name: "social media marketing", aliases: ["smma", "social media marketing agency", "social media marketing"], related: ["digital marketing"] },
  { name: "mentorship", aliases: ["mentoring", "mentorship", "mentor"], related: ["coaching"] },
] as const;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function interpretSearch(value: unknown) {
  if (typeof value !== "string") throw new Error("Search must be text.");
  if (value.length > 160) throw new Error("Use 160 characters or fewer.");
  const raw = value.trim();
  let normalized = normalizeSearchText(raw);
  const related = new Set<string>();
  // Long aliases first prevents shorter words from consuming a phrase.
  const aliases = TOPICS.flatMap(topic => topic.aliases.map(alias => ({ topic, alias: normalizeSearchText(alias) })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { topic, alias } of aliases) {
    const pattern = new RegExp(`(^| )${alias}(?= |$)`, "g");
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, (_, start: string) => `${start}${topic.name}`);
    }
  }
  for (const topic of TOPICS) {
    const pattern = new RegExp(`(^| )${topic.name}(?= |$)`, "g");
    if (pattern.test(normalized)) topic.related.forEach(term => related.add(normalized.replace(pattern, (_, start: string) => `${start}${term}`)));
  }
  return { raw, normalized, related: [...related].filter(term => term !== normalized), isTagSearch: raw.startsWith("#") };
}

export const SEARCH_PAGE_SIZE = 20;
