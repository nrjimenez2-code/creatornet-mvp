import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabaseClient";
import { createPresignedUploadUrl, r2PublicUrl } from "@/lib/r2";

export async function POST(req: NextRequest) {
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

  const allowedFolders = ["videos", "thumbnails"];
  if (!allowedFolders.includes(folder)) {
    return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
  }

  const ext = (filename as string).split(".").pop() ?? "bin";
  const key = `${folder}/${user.id}/${Date.now()}.${ext}`;

  const uploadUrl = await createPresignedUploadUrl(key, contentType as string);
  const publicUrl = r2PublicUrl(key);

  return NextResponse.json({ uploadUrl, publicUrl, key });
}
