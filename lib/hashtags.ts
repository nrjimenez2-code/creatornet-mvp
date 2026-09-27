/** Canonical whole tag used by array writes and search. */
export function normalizeHashtag(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^#/, "").trim().toLowerCase();
}

export function normalizeHashtags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizeHashtag).filter(Boolean)));
}

/** Literal caption tag, with the same end boundary as the hashtag parser. */
export function captionHashtagPattern(tag: string): string {
  const literal = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `#${literal}([^a-z0-9_]|$)`;
}

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const set = new Set<string>();
  const regex = /#([a-z0-9_]+)/gi;
  let m;

  while ((m = regex.exec(text))) {
    set.add(normalizeHashtag(m[1]));
  }

  return Array.from(set);
}
