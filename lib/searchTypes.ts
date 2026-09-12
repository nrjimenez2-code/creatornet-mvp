export type SearchCreator = {
  id: string; username: string; full_name: string | null; avatar_url: string | null;
  tagline: string | null; match_reason: string; match_evidence: string; related_match: boolean;
};
export type SearchPost = {
  id: string; caption: string | null; content: string | null; media_url: string | null;
  poster_url: string | null; creator_id: string; creator: { username: string };
};
export type SearchOffering = {
  id: string; title: string; creator_id: string; creator_username: string; post_id?: string;
  price_cents: number | null; currency: string | null; type: string | null;
};
export type SearchResponse = {
  creators: SearchCreator[]; items: SearchPost[]; offerings: SearchOffering[];
  totals: { creators: number; videos: number; offerings: number };
  page: number; page_size: number; normalized_query?: string;
};
export const EMPTY_SEARCH: SearchResponse = {
  creators: [], items: [], offerings: [], totals: { creators: 0, videos: 0, offerings: 0 }, page: 0, page_size: 20,
};
