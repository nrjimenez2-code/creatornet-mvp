import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { admitRequest, admissionResponse } from "@/lib/abuse/admission";
import { createServerSupabase } from "@/lib/supabaseClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createPresignedUploadUrl, r2PublicUrl, headR2Object } from "@/lib/r2";
import { isAllowedUpload, maxBytesFor, safeExtension, type UploadFolder } from "@/lib/uploadPolicy";
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
  if (user.is_anonymous || !(user.email_confirmed_at || user.phone_confirmed_at)) {
    return NextResponse.json({error:"Verify your account before uploading."},{status:403});
  }

  const body = await req.json().catch(() => null);
  const { filename, contentType, folder, size, operationId, uploadContract, verifyExisting } = body ?? {};
  if (uploadContract !== "create-only-v1") {
    return NextResponse.json({error:"Please refresh CreatorNet before uploading.",code:"UPLOAD_CLIENT_REFRESH_REQUIRED"},{status:409});
  }
  if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId))) {
    return NextResponse.json({error:"Invalid upload operation."},{status:400});
  }

  if (typeof filename !== "string" || !filename.trim() || filename.length > 255 ||
      typeof contentType !== "string" || !contentType.trim() || contentType.length > 100 || !folder) {
    return NextResponse.json(
      { error: "filename, contentType, and folder are required" },
      { status: 400 }
    );
  }

  const allowedFolders: UploadFolder[] = ["videos", "thumbnails"];
  if (!allowedFolders.includes(folder)) {
    return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
  }

  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytesFor(folder)) {
    return NextResponse.json({ error: "Invalid upload size or file exceeds the upload limit." }, { status: 400 });
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

  try {
    const profile=await supabaseAdmin.from("profiles").select("banned_at").eq("id",user.id).maybeSingle();
    if(profile.error || !profile.data || profile.data.banned_at !== null) return NextResponse.json({error:"Uploads unavailable for this account."},{status:403});
  }catch{return NextResponse.json({error:"Upload status is unavailable."},{status:503});}

  const ext = safeExtension(filename, folder);
  // Updated clients retain this operation across retries. Cached clients must
  // refresh to send the explicit conditional-upload contract checked above.
  const operation = operationId?.toLowerCase() ?? randomUUID();
  const mime = String(contentType).trim().toLowerCase();
  const key = `${folder}/${user.id}/launch_${operation}.${ext}`;
  try {
    const admission = await admitRequest(req,"public_upload",`user:${user.id}`, {
      operation:`public:${user.id}:${operation}`,contract:JSON.stringify({folder,ext,size,mime}),resource:key,bytes:size,
    });
    if (admission.resource !== key) throw new Error("Upload reservation identity mismatch");
    if (verifyExisting === true) {
      if (!admission.reused) return NextResponse.json({error:"Upload could not be recovered. Please try again."},{status:409});
      const head = await headR2Object(key);
      if (!head || head.size !== size || head.contentType !== mime) return NextResponse.json({error:"Upload could not be verified. Please try again."},{status:503});
      return NextResponse.json({alreadyUploaded:true,publicUrl:r2PublicUrl(key),key},{headers:{"Cache-Control":"private, no-store"}});
    }
  } catch (error) { return admissionResponse(error) ?? NextResponse.json({error:"Upload recovery is unavailable."},{status:503}); }
  const uploadUrl = await createPresignedUploadUrl(key, mime, size);
  const publicUrl = r2PublicUrl(key);

  return NextResponse.json({ uploadUrl, publicUrl, key },{headers:{"Cache-Control":"private, no-store"}});
}
