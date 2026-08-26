// lib/premiumPath.ts — who may point a post at which premium file.
//
// posts.premium_path is a key in the private `premium` storage bucket, and
// /api/watch signs whatever path the post carries once the caller is the
// post's creator or a buyer. Before this, POST /api/posts stored any string,
// so a user could create a post whose premium_path was another creator's
// file and sign it as "the creator". The composer always uploads under
// `${userId}/...` (every existing row in production follows that shape), so
// requiring the creator's own folder costs nothing and closes the hole.

export function isOwnPremiumPath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || !userId) return false;
  const p = path.trim();
  if (!p || p.length > 512) return false;
  if (p.includes("..") || p.includes("\\") || p.startsWith("/")) return false;
  return p.startsWith(`${userId}/`) && p.length > userId.length + 1;
}
