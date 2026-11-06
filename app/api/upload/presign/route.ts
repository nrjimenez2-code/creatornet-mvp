import { NextRequest, NextResponse } from "next/server";
import { hasLegacyPublicUploadReservation } from "@/lib/legacyPublicUpload";
import { createServerSupabase } from "@/lib/supabaseClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { r2PublicUrl, headR2Object } from "@/lib/r2";
import { isAllowedUpload, maxBytesFor, safeExtension, type UploadFolder } from "@/lib/uploadPolicy";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

// Legacy clients may only verify an exact admitted object. Fresh uploads must
// refresh onto the durable tracking protocol. No capability is issued here.
const PRESIGN_RATE = { limit: 30, windowMs: 60_000 };
function reply(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers); headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(req: NextRequest) {
  if (!allowRequest(`presign:${clientKey(req)}`, PRESIGN_RATE)) {
    const response = tooManyRequests(); response.headers.set("Cache-Control", "private, no-store"); return response;
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return reply({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.is_anonymous || !(user.email_confirmed_at || user.phone_confirmed_at)) {
    return reply({error:"Verify your account before uploading."},{status:403});
  }

  const body = await req.json().catch(() => null);
  const { filename, contentType, folder, size, operationId, uploadContract, verifyExisting } = body ?? {};
  if (uploadContract !== "create-only-v1") {
    return reply({error:"Please refresh CreatorNet before uploading.",code:"UPLOAD_CLIENT_REFRESH_REQUIRED"},{status:409});
  }
  if (operationId !== undefined && (typeof operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId))) {
    return reply({error:"Invalid upload operation."},{status:400});
  }

  if (typeof filename !== "string" || !filename.trim() || filename.length > 255 ||
      typeof contentType !== "string" || !contentType.trim() || contentType.length > 100 || !folder) {
    return reply(
      { error: "filename, contentType, and folder are required" },
      { status: 400 }
    );
  }

  const allowedFolders: UploadFolder[] = ["videos", "thumbnails"];
  if (!allowedFolders.includes(folder)) {
    return reply({ error: "Invalid folder" }, { status: 400 });
  }

  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytesFor(folder)) {
    return reply({ error: "Invalid upload size or file exceeds the upload limit." }, { status: 400 });
  }

  // Content-Type is part of the signature, so R2 rejects a PUT whose type
  // differs from what was signed here. This is what keeps text/html out of
  // the public bucket.
  if (!isAllowedUpload(folder, contentType)) {
    return reply(
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
    if(profile.error || !profile.data || profile.data.banned_at !== null) return reply({error:"Uploads unavailable for this account."},{status:403});
  }catch{return reply({error:"Upload status is unavailable."},{status:503});}

  // Fresh legacy signing is retired. Existing admitted work can verify only
  // its exact original object; no gate, admission debit or capability is issued.
  if (verifyExisting !== true) {
    return reply({error:'Please refresh CreatorNet before uploading.',code:'UPLOAD_CLIENT_REFRESH_REQUIRED'},
      {status:409,headers:{'Cache-Control':'private, no-store'}});
  }
  if (typeof operationId !== 'string') {
    return reply({error:'The original upload operation is required.'},{status:400});
  }
  const ext = safeExtension(filename, folder);
  const operation = operationId.toLowerCase();
  const mime = String(contentType).trim().toLowerCase();
  const ownerId = user.id.toLowerCase();
  const key = folder + '/' + ownerId + '/launch_' + operation + '.' + ext;
  try {
    const reserved = await hasLegacyPublicUploadReservation({
      ownerId, operationId:operation, folder, extension:ext, size, contentType:mime, key,
    });
    if (!reserved) return reply({error:'Original upload reservation was not found.'},{status:409});
    const head = await headR2Object(key);
    if (!head || head.size !== size || head.contentType !== mime) {
      return reply({error:'Upload could not be verified. Please try again.'},{status:503});
    }
    return reply({alreadyUploaded:true,publicUrl:r2PublicUrl(key),key},
      {headers:{'Cache-Control':'private, no-store'}});
  } catch {
    return reply({error:'Upload recovery is unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
  }
}
