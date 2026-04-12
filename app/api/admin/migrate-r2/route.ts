/**
 * One-time migration route: copies existing Supabase Storage videos/thumbnails
 * to Cloudflare R2 and updates the post rows with the new public URLs.
 *
 * Protected by a secret header — call with:
 *   POST /api/admin/migrate-r2
 *   x-migrate-secret: <MIGRATE_SECRET env var>
 *
 * Idempotent: skips posts whose video_url already points to R2.
 */

import { NextRequest, NextResponse } from "next/server";
import { r2Client, R2_BUCKET, r2PublicUrl } from "@/lib/r2";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient as supabaseAdmin } from "@supabase/supabase-js";

const MIGRATE_SECRET = process.env.MIGRATE_SECRET ?? "change-me-before-use";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

function isAlreadyR2(url: string | null): boolean {
  if (!url) return false;
  return url.startsWith(R2_PUBLIC_URL);
}

/** Extract the storage path from a Supabase public URL.
 *  e.g. https://xxx.supabase.co/storage/v1/object/public/videos/uid/file.mp4
 *       → bucket: "videos", path: "uid/file.mp4"
 */
function parseSupabasePath(url: string): { bucket: string; path: string } | null {
  try {
    const match = url.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(\?|$)/);
    if (!match) return null;
    return { bucket: match[1], path: match[2] };
  } catch {
    return null;
  }
}

async function migrateFile(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  oldUrl: string,
  r2Folder: string
): Promise<string | null> {
  try {
    // Try Supabase admin download first (works for both public and private buckets)
    const parsed = parseSupabasePath(oldUrl);
    let buffer: ArrayBuffer | null = null;
    let contentType = "application/octet-stream";

    if (parsed) {
      const { data, error } = await admin.storage
        .from(parsed.bucket)
        .download(parsed.path);

      if (!error && data) {
        buffer = await data.arrayBuffer();
        contentType = data.type || contentType;
      }
    }

    // Fallback: plain fetch (works if bucket is public)
    if (!buffer) {
      const res = await fetch(oldUrl);
      if (!res.ok) return null;
      buffer = await res.arrayBuffer();
      contentType = res.headers.get("content-type") ?? contentType;
    }

    // Derive a stable key from the original URL filename
    const urlPath = new URL(oldUrl).pathname;
    const filename = urlPath.split("/").pop()?.split("?")[0] ?? `${Date.now()}`;
    const key = `${r2Folder}/${filename}`;

    await r2Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: Buffer.from(buffer),
        ContentType: contentType,
      })
    );

    return r2PublicUrl(key);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-migrate-secret") !== MIGRATE_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = supabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: posts, error } = await admin
    .from("posts")
    .select("id, video_url, poster_url")
    .not("video_url", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = {
    total: posts?.length ?? 0,
    skipped: 0,
    migrated: 0,
    failed: 0,
    errors: [] as string[],
  };

  for (const post of posts ?? []) {
    if (isAlreadyR2(post.video_url)) {
      results.skipped++;
      continue;
    }

    const updates: { video_url?: string; poster_url?: string } = {};

    const newVideoUrl = await migrateFile(admin, post.video_url, "videos");
    if (newVideoUrl) {
      updates.video_url = newVideoUrl;
    } else {
      results.errors.push(`post ${post.id}: failed to migrate video_url [${post.video_url}]`);
    }

    if (post.poster_url && !isAlreadyR2(post.poster_url)) {
      const newPosterUrl = await migrateFile(admin, post.poster_url, "thumbnails");
      if (newPosterUrl) updates.poster_url = newPosterUrl;
    }

    if (Object.keys(updates).length > 0) {
      const { error: upErr } = await admin
        .from("posts")
        .update(updates)
        .eq("id", post.id);

      if (upErr) {
        results.failed++;
        results.errors.push(`post ${post.id}: DB update failed — ${upErr.message}`);
      } else {
        results.migrated++;
      }
    } else {
      results.failed++;
    }
  }

  return NextResponse.json(results);
}
