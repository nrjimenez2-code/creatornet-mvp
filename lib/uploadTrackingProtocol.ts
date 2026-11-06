import {
  IMAGE_TYPES,
  isAllowedUpload,
  maxBytesFor,
  safeExtension,
} from "./uploadPolicy";

export const UPLOAD_PURPOSES = ["video", "thumbnail", "premium", "avatar"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
export type UploadProvider = "r2" | "supabase";
export type ClientUploadOutcome = "uploaded" | "failed" | "aborted";
export type UploadAttemptState =
  | "reserved"
  | "capability_issued"
  | "object_observed"
  | "verification_unavailable"
  | "object_mismatch";

export class UploadTrackingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadTrackingError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function providerForPurpose(purpose: UploadPurpose): UploadProvider {
  return purpose === "video" || purpose === "thumbnail" ? "r2" : "supabase";
}

export function bucketForPurpose(purpose: UploadPurpose, r2Bucket: string): string {
  if (purpose === "premium") return "premium";
  if (purpose === "avatar") return "avatars";
  if (!r2Bucket || r2Bucket.length > 128 || /[\u0000-\u001f]/.test(r2Bucket)) {
    throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Uploads are temporarily unavailable.", 503);
  }
  return r2Bucket;
}

export function maxBytesForPurpose(purpose: UploadPurpose): number {
  if (purpose === "video") return maxBytesFor("videos");
  if (purpose === "thumbnail") return maxBytesFor("thumbnails");
  // Premium previously had no application size cap. Preserve that entitlement;
  // the bucket/provider's existing limits still apply.
  if (purpose === "premium") return Number.MAX_SAFE_INTEGER;
  return 5 * 1024 * 1024;
}

export function contentTypeAllowed(purpose: UploadPurpose, value: string): boolean {
  if (!MIME.test(value)) return false;
  if (purpose === "video") return isAllowedUpload("videos", value);
  if (purpose === "thumbnail") return isAllowedUpload("thumbnails", value);
  if (purpose === "avatar") return IMAGE_TYPES.has(value);
  return true;
}

export interface UploadAdmissionInput {
  attemptId: string;
  operationId: string;
  ownerId: string;
  purpose: UploadPurpose;
  contentType: string;
  expectedBytes: number | null;
  extension: string;
}

export function parseUploadAdmission(
  body: unknown,
  ownerId: string,
  createId: () => string,
): UploadAdmissionInput {
  if (!isUploadId(ownerId)) {
    throw new UploadTrackingError("UNAUTHORIZED", "Unauthorized.", 401);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload request.", 400);
  }
  const raw = body as Record<string, unknown>;
  const purpose = raw.purpose;
  if (!UPLOAD_PURPOSES.includes(purpose as UploadPurpose)) {
    throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload purpose.", 400);
  }
  const target = purpose as UploadPurpose;
  if (typeof raw.filename !== "string" || !raw.filename.trim() || raw.filename.length > 512) {
    throw new UploadTrackingError("INVALID_UPLOAD", "A filename is required.", 400);
  }
  const contentType = typeof raw.contentType === "string" ? raw.contentType.trim().toLowerCase() : "";
  if (contentType.length > 128 || !contentTypeAllowed(target, contentType)) {
    throw new UploadTrackingError("INVALID_UPLOAD", "That file type cannot be uploaded here.", 400);
  }
  const expectedBytes = raw.size;
  if (
    !Number.isSafeInteger(expectedBytes) ||
      (expectedBytes as number) <= 0 ||
      (expectedBytes as number) > maxBytesForPurpose(target)
  ) {
    throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload size.", 400);
  }
  const attemptId = raw.attemptId ?? createId();
  const operationId = raw.operationId ?? attemptId;
  if (!isUploadId(attemptId) || !isUploadId(operationId)) {
    throw new UploadTrackingError("INVALID_UPLOAD", "Invalid upload attempt.", 400);
  }
  return {
    attemptId: attemptId.toLowerCase(),
    operationId: operationId.toLowerCase(),
    ownerId: ownerId.toLowerCase(),
    purpose: target,
    contentType,
    expectedBytes: expectedBytes as number | null,
    extension: safeExtension(raw.filename, target === "thumbnail" || target === "avatar" ? "thumbnails" : "videos"),
  };
}

export function keyForUpload(input: UploadAdmissionInput): string {
  const file = input.attemptId + "." + input.extension;
  if (input.purpose === "video") return "videos/" + input.ownerId + "/launch_" + file;
  if (input.purpose === "thumbnail") return "thumbnails/" + input.ownerId + "/launch_" + file;
  return input.ownerId + "/" + file;
}

/** Durable metadata only. A signed URL or token must never enter this record. */
export interface UploadAttempt extends UploadAdmissionInput {
  provider: UploadProvider;
  bucket: string;
  key: string;
  admissionGeneration: number;
  state: UploadAttemptState;
  admittedAt: string;
  capabilityIssuedAt: string | null;
  nominalExpiresAt: string | null;
  clientOutcome: ClientUploadOutcome | null;
  observedObject: UploadObjectObservation | null;
}

export interface UploadObjectObservation {
  size: number;
  contentType: string;
  etag: string | null;
  version: string | null;
}

export function normalizedObservation(
  input: unknown,
): UploadObjectObservation | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) return null;
  const contentType =
    typeof value.contentType === "string" ? value.contentType.split(";")[0].trim().toLowerCase() : "";
  if (!contentType || contentType.length > 128 || !MIME.test(contentType)) return null;
  const identityPart = (part: unknown): string | null =>
    typeof part === "string" && part.length <= 512 && !/[\u0000-\u001f]/.test(part) ? part : null;
  return {
    size: value.size as number,
    contentType,
    etag: identityPart(value.etag),
    version: identityPart(value.version),
  };
}

export function observationMatches(
  attempt: UploadAttempt,
  object: UploadObjectObservation,
): boolean {
  return (
    (attempt.expectedBytes === null || object.size === attempt.expectedBytes) &&
    object.size <= maxBytesForPurpose(attempt.purpose) &&
    object.contentType === attempt.contentType &&
    contentTypeAllowed(attempt.purpose, object.contentType)
  );
}

/** Stable metadata identity, not a content hash or proof of immutable bytes. */
export function observationIdentity(value: UploadObjectObservation): string {
  return JSON.stringify([value.size, value.contentType, value.etag, value.version]);
}

export function unresolvedUploadReasons(attempt: UploadAttempt): string[] {
  const reasons = ["provider_write_quiescence_unproven"];
  if (attempt.capabilityIssuedAt === null) reasons.push("issuance_not_confirmed");
  if (!attempt.observedObject) reasons.push("object_not_verified");
  if (attempt.state === "verification_unavailable") reasons.push("verification_unavailable");
  if (attempt.state === "object_mismatch") reasons.push("object_metadata_mismatch");
  if (attempt.clientOutcome === "failed" || attempt.clientOutcome === "aborted") {
    reasons.push("client_report_does_not_prove_provider_stopped");
  }
  return reasons;
}

