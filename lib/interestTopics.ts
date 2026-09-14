import {
  normalizeInterests,
  type InterestCategory,
} from "@/lib/interestCategories";

/** Explainable text matching only; no transcripts or visual analysis. */
const TOPICS: { topic: string; category: InterestCategory; terms: string[] }[] =
  [
    {
      topic: "ecommerce",
      category: "business & entrepreneurship",
      terms: ["e commerce", "ecommerce", "ecom", "shopify", "online store"],
    },
    {
      topic: "dropshipping",
      category: "business & entrepreneurship",
      terms: ["dropshipping", "drop shipping"],
    },
    {
      topic: "startups",
      category: "business & entrepreneurship",
      terms: ["startup", "startups", "business launch"],
    },
    {
      topic: "investing",
      category: "money & investing",
      terms: ["investing", "investment", "stocks", "etf"],
    },
    {
      topic: "personal finance",
      category: "money & investing",
      terms: ["budgeting", "personal finance", "saving money"],
    },
    {
      topic: "social media growth",
      category: "content creation & marketing",
      terms: [
        "social media growth",
        "grow followers",
        "instagram growth",
        "tiktok growth",
      ],
    },
    {
      topic: "content creation",
      category: "content creation & marketing",
      terms: ["content creation", "video editing", "filmmaking", "ugc"],
    },
    {
      topic: "marketing",
      category: "content creation & marketing",
      terms: ["marketing", "seo", "copywriting", "smma"],
    },
    {
      topic: "artificial intelligence",
      category: "technology & ai",
      terms: ["ai", "artificial intelligence", "machine learning"],
    },
    {
      topic: "automation",
      category: "technology & ai",
      terms: ["automation", "automate", "n8n"],
    },
    {
      topic: "programming",
      category: "technology & ai",
      terms: ["programming", "coding", "software development"],
    },
    {
      topic: "strength training",
      category: "health & fitness",
      terms: ["strength training", "weightlifting", "bodybuilding"],
    },
    {
      topic: "nutrition",
      category: "health & fitness",
      terms: ["nutrition", "meal prep"],
    },
    {
      topic: "personal growth",
      category: "personal growth & relationships",
      terms: ["personal growth", "self improvement", "productivity", "habits"],
    },
    {
      topic: "relationships",
      category: "personal growth & relationships",
      terms: ["relationships", "dating", "communication skills"],
    },
    {
      topic: "design",
      category: "arts, design & hobbies",
      terms: ["design", "illustration", "typography"],
    },
    {
      topic: "music",
      category: "arts, design & hobbies",
      terms: ["music", "guitar", "piano", "songwriting"],
    },
    {
      topic: "photography",
      category: "arts, design & hobbies",
      terms: ["photography", "photographer"],
    },
    {
      topic: "career skills",
      category: "education & career skills",
      terms: ["career", "resume", "job interview", "online skills"],
    },
    {
      topic: "languages",
      category: "education & career skills",
      terms: ["language learning", "learn spanish", "learn english"],
    },
  ];
export function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return text && text.length <= 80 ? text : null;
}
export function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .slice(0, 20)
        .map(normalizeTopic)
        .filter((v): v is string => !!v),
    ),
  ];
}
export function matchInterestTopics(input: {
  interests?: unknown;
  topics?: unknown;
  title?: string | null;
  description?: string | null;
  offers?: { title?: string | null; description?: string | null }[];
}): { categories: InterestCategory[]; topics: string[] } {
  const categories = new Set(normalizeInterests(input.interests));
  const topics = new Set(normalizeTopics(input.topics));
  const text =
    " " +
    [
      input.title,
      input.description,
      ...topics,
      ...(input.offers ?? []).flatMap((o) => [o.title, o.description]),
    ]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ") +
    " ";
  for (const entry of TOPICS) {
    if (entry.terms.some((term) => text.includes(" " + term + " "))) {
      topics.add(entry.topic);
      categories.add(entry.category);
    }
  }
  if (topics.has("ecommerce") && /\b(mentor(ship|ing)?|coaching)\b/.test(text))
    topics.add("ecommerce mentorship");
  return { categories: [...categories], topics: [...topics] };
}
