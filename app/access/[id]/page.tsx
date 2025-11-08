// app/access/[id]/page.tsx
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export default async function AccessPage({ params }: { params: { id: string } }) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Example: load the post/video by id (optional)
  const { data: post } = await supabase.from("posts").select("id,title,video_url").eq("id", params.id).maybeSingle();

  return (
    <main className="min-h-screen p-8 flex flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold">✅ Access granted</h1>
      <p className="opacity-80">Post ID: {params.id}</p>
      {post?.title && <p className="opacity-80">Title: {post.title}</p>}
      {post?.video_url && (
        <video src={post.video_url} controls className="w-full max-w-xl rounded-xl shadow" />
      )}
    </main>
  );
}
