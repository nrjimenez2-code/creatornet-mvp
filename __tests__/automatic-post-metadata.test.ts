import { automaticPostMetadata, parseVideoUnderstanding } from "@/lib/automaticPostMetadata";

const understanding = (overrides: Record<string, unknown> = {}) => ({ transcript: "", screen_text: "", visual_summary: "", labels: [], ...overrides });
test.each([
  [{ content: "An ecommerce lesson" }, "business & entrepreneurship", "ecommerce"],
  [{ content: "#SMMA" }, "content creation & marketing", "marketing"],
  [{ content: "", offers: [{ title: "Learn programming" }] }, "technology & ai", "programming"],
  [{ content: "", bio: "I teach strength training" }, "health & fitness", "strength training"],
])("derives metadata using the existing matcher: %j", (context, category, topic) => {
  const result = automaticPostMetadata(context);
  expect(result.interests).toContain(category);
  expect(result.topics).toContain(topic);
});
test("unclassified posts can publish without inventing hashtags or using learning interests", () => {
  const result = automaticPostMetadata({ content: "hello #UNKNOWN", ...{ interests: ["investing"] } });
  expect(result).toEqual({ interests: [], topics: ["unknown"], hashtags: ["unknown"], source: "unclassified" });
});
test("silent visual evidence replaces provisional profile fallback and remains outside transcripts", () => {
  const context = { bio: "Ecommerce mentor" };
  expect(automaticPostMetadata(context).source).toBe("profile_fallback");
  const video = parseVideoUnderstanding(JSON.stringify(understanding({ visual_summary: "A person lifts a barbell.", labels: [{
    category: "health & fitness", topics: ["weightlifting"], evidence: [{ kind: "visual", text: "Repeated barbell lifts", start_seconds: 1, end_seconds: 4 }],
  }] })), 5);
  const result = automaticPostMetadata(context, video);
  expect(result.interests).toEqual(["health & fitness"]);
  expect(result.topics).toEqual(["strength training"]);
  expect(result.hashtags).toEqual([]);
  expect(video.transcript).toBe("");
});
test("speech and screen evidence combine with direct post text and mixed topics", () => {
  const video = parseVideoUnderstanding(JSON.stringify(understanding({ transcript: "Today we learn programming", screen_text: "Learn piano", labels: [
    { category: "technology & ai", topics: ["coding"], evidence: [{ kind: "speech", text: "learn programming" }] },
    { category: "arts, design & hobbies", topics: ["piano"], evidence: [{ kind: "screen_text", text: "Learn piano" }] },
  ] })));
  expect(automaticPostMetadata({ content: "#investing", bio: "Ecommerce mentor" }, video).interests)
    .toEqual(["money & investing", "technology & ai", "arts, design & hobbies"]);
});
test("unclear video evidence leaves the public profile fallback available", () => {
  const video = parseVideoUnderstanding(JSON.stringify(understanding()));
  expect(automaticPostMetadata({ tagline: "Learn guitar" }, video).source).toBe("profile_fallback");
});
test.each([
  "not JSON", "null", JSON.stringify(understanding({ labels: [{}] })),
  JSON.stringify(understanding({ labels: [{ category: "medicine", topics: [], evidence: [{ kind: "speech", text: "hello" }] }] })),
  JSON.stringify(understanding({ labels: [{ category: "health & fitness", topics: [], evidence: [] }] })),
  JSON.stringify(understanding({ labels: [{ category: "health & fitness", topics: [], evidence: [{ kind: "speech", text: "invented" }] }] })),
  JSON.stringify(understanding({ labels: [{ category: "health & fitness", topics: [], evidence: [{ kind: "visual", text: "lifts weights", start_seconds: 0, end_seconds: 7 }] }] })),
  JSON.stringify(understanding({ labels: [{ category: "health & fitness", topics: ["x".repeat(81)], evidence: [{ kind: "visual", text: "lifts weights", start_seconds: 0, end_seconds: 1 }] }] })),
])("rejects malformed, unsupported, or unevidenced model output", raw => {
  expect(() => parseVideoUnderstanding(raw, 5)).toThrow("invalid_extraction");
});
