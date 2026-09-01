import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabaseClient";
import { createPresignedUploadUrl, r2PublicUrl } from "@/lib/r2";
import { isAllowedUpload, safeExtension, type UploadFolder } from "@/lib/uploadPolicy";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

// Each call hands out a signed URL that can write to object storage. Thirty a
// minute covers a real upload session with room to spare.
const PRESIGN_RATE = { limit: 30, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  if (!allowRequest(`presign:${clientKey(req)}`, PRESIGN_RATE)) {
    return tooManyRequests();
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const { filename, contentType, folder } = body ?? {};

  if (!filename || !contentType || !folder) {
    return NextResponse.json(
      { error: "filename, contentType, and folder are required" },
      { status: 400 }
    );
  }

  const allowedFolders: UploadFolder[] = ["videos", "thumbnails"];
  if (!allowedFolders.includes(folder)) {
    return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
  }

  // Content-Type is part of the signature, so R2 rejects a PUT whose type
  // differs from what was signed here. This is what keeps text/html out of
  // the public bucket.
  if (!isAllowedUpload(folder, contentType)) {
    return NextResponse.json(
      {
        error:
          folder === "videos"
            ? "Please upload a video file (MP4, MOV or WebM)."
            : "Please upload an image file (JPG, PNG or WebP).",
      },
      { status: 400 }
    );
  }

  const ext = safeExtension(filename, folder);
  const key = `${folder}/${user.id}/${Date.now()}.${ext}`;

  const uploadUrl = await createPresignedUploadUrl(key, String(contentType).trim().toLowerCase());
  const publicUrl = r2PublicUrl(key);

  return NextResponse.json({ uploadUrl, publicUrl, key });
}
