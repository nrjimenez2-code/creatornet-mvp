// lib/postMetrics.ts
import { supabase } from "@/lib/supabaseClient";

export async function likePost(postId: string) {
  return supabase.rpc("increment_post_likes", { p_post_id: postId });
}
export async function commentCountPost(postId: string) {
  return supabase.rpc("increment_post_comments", { p_post_id: postId });
}
export async function sharePost(postId: string) {
  return supabase.rpc("increment_post_shares", { p_post_id: postId });
}
