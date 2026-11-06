import "server-only";
import { randomUUID } from "node:crypto";
import { admitRequest, admissionResponse } from "./abuse/admission";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "./supabaseClient";
import { supabaseAdmin } from "./supabaseAdmin";
import { allowRequest, clientKey, tooManyRequests } from "./rateLimit";
import { parseUploadAdmission, keyForUpload, isUploadId, UploadTrackingError } from "./uploadTrackingProtocol";
import { UploadTrackingRuntime } from "./uploadTracking";
import { SupabaseUploadTrackingStore } from "./uploadTrackingStore";
import { StorageUploadTrackingProviders } from "./uploadTrackingProviders";

const HEADERS = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  const admission = admissionResponse(error);
  if (admission) return admission;
  return NextResponse.json({
    error: error instanceof UploadTrackingError ? error.message : "Upload tracking is temporarily unavailable.",
    code: error instanceof UploadTrackingError ? error.code : "UPLOAD_UNAVAILABLE",
  }, { status: error instanceof UploadTrackingError ? error.status : 503, headers: HEADERS });
}
async function context() {
  const actor = await createServerSupabase();
  const { data: { user }, error } = await actor.auth.getUser();
  if (error || !user || !isUploadId(user.id)) throw new UploadTrackingError("UNAUTHORIZED", "Unauthorized.", 401);
  return {
    user, ownerId: user.id.toLowerCase(),
    runtime: new UploadTrackingRuntime(new SupabaseUploadTrackingStore(supabaseAdmin),
      new StorageUploadTrackingProviders(actor, supabaseAdmin),
      () => process.env.UPLOAD_ADMISSION_PAUSED === "1"),
  };
}
export async function admitUpload(req: NextRequest) {
  try {
    if (!allowRequest('presign:' + clientKey(req), { limit: 30, windowMs: 60_000 })) {
      const response = tooManyRequests(); response.headers.set('Cache-Control', 'no-store'); return response;
    }
    const { ownerId, user, runtime } = await context();
    const body = await req.json().catch(() => null);
    const input = parseUploadAdmission(body, ownerId, randomUUID);
    if (input.purpose === 'video' || input.purpose === 'thumbnail') {
      if (user.is_anonymous || !(user.email_confirmed_at || user.phone_confirmed_at)) {
        throw new UploadTrackingError('UPLOAD_ACCOUNT_UNVERIFIED', 'Verify your account before uploading.', 403);
      }
      if (body.uploadContract !== 'create-only-v1') {
        throw new UploadTrackingError('UPLOAD_CLIENT_REFRESH_REQUIRED', 'Please refresh CreatorNet before uploading.', 409);
      }
      if (body.filename.length > 255 || body.contentType.length > 100) {
        throw new UploadTrackingError('INVALID_UPLOAD', 'Invalid upload metadata.', 400);
      }
      const profile = await supabaseAdmin.from('profiles').select('banned_at').eq('id', ownerId).maybeSingle();
      if (profile.error || !profile.data || profile.data.banned_at !== null) {
        throw new UploadTrackingError('UPLOAD_ACCOUNT_UNAVAILABLE', 'Uploads unavailable for this account.', 403);
      }
      const folder = input.purpose === 'video' ? 'videos' : 'thumbnails';
      const key = keyForUpload(input);
      // Each immutable attempt owns its own quota resource. The operationId
      // groups retries, but must not collapse their distinct tracked objects.
      const admission = await admitRequest(req, 'public_upload', 'user:' + ownerId, {
        operation: 'public:' + ownerId + ':' + input.attemptId,
        contract: JSON.stringify({ folder, ext: input.extension, size: input.expectedBytes, mime: input.contentType }),
        resource: key, bytes: input.expectedBytes!,
      });
      if (admission.resource !== key) throw new Error('Upload reservation identity mismatch');
    }
    return NextResponse.json(await runtime.begin(input), { headers: HEADERS });
  } catch (error) { return failure(error); }
}
export async function reconcileUpload(req: NextRequest, id: string, readOnly = false) {
  try {
    const { ownerId, runtime } = await context();
    if (!isUploadId(id)) throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload attempt.", 400);
    if (readOnly) return NextResponse.json(await runtime.status(id.toLowerCase(), ownerId), { headers: HEADERS });
    if (!allowRequest(`upload-reconcile:${ownerId}:${clientKey(req)}`, { limit: 90, windowMs: 60_000 })) {
      const response = tooManyRequests(); response.headers.set("Cache-Control", "no-store"); return response;
    }
    const body = await req.json().catch(() => null);
    // Never accept a browser's object metadata, bucket, key, or claimed owner.
    if (!body || Object.keys(body).some(k => k !== "outcome") ||
        !["uploaded", "failed", "aborted"].includes(body.outcome)) {
      throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload outcome.", 400);
    }
    const result = await runtime.complete(id.toLowerCase(), ownerId, body.outcome);
    return NextResponse.json(result.upload, { status: result.status, headers: HEADERS });
  } catch (error) { return failure(error); }
}
