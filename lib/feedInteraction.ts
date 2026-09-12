import type { PostRow } from "./feedV3";

// Authoritative mutation responses survive VideoCard virtualization.
export type FeedInteraction = Partial<Pick<PostRow, "is_liked" | "likes_count" | "comments_count" | "shares_count">>;
