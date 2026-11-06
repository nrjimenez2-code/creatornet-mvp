import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizedObservation, UploadTrackingError, type UploadAdmissionInput,
  type UploadAttempt, type UploadAttemptState, type UploadPurpose,
} from "./uploadTrackingProtocol";
import type { UploadTrackingStore } from "./uploadTracking";

const STATES = new Set(["reserved", "capability_issued", "object_observed", "verification_unavailable", "object_mismatch"]);
function unavailable(): never {
  throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Upload tracking is temporarily unavailable.", 503);
}
function decodeAttempt(value: unknown): UploadAttempt {
  if (!value || typeof value !== "object") return unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.operation_id !== "string" ||
      typeof row.owner_id !== "string" || typeof row.object_key !== "string" ||
      typeof row.bucket !== "string" || typeof row.content_type !== "string" ||
      typeof row.extension !== "string" || typeof row.admitted_at !== "string" ||
      !Number.isSafeInteger(row.admission_generation) || !STATES.has(String(row.state)) ||
      !["video", "thumbnail", "premium", "avatar"].includes(String(row.purpose)) ||
      !["r2", "supabase"].includes(String(row.provider)) ||
      (row.expected_bytes !== null && !Number.isSafeInteger(row.expected_bytes))) return unavailable();
  return {
    attemptId: row.id,
    operationId: row.operation_id,
    ownerId: row.owner_id,
    key: row.object_key,
    bucket: row.bucket,
    purpose: row.purpose as UploadPurpose,
    provider: row.provider as "r2" | "supabase",
    contentType: row.content_type,
    extension: row.extension,
    expectedBytes: row.expected_bytes as number | null,
    admissionGeneration: row.admission_generation as number,
    state: row.state as UploadAttemptState,
    admittedAt: row.admitted_at,
    capabilityIssuedAt: typeof row.capability_issued_at === "string" ? row.capability_issued_at : null,
    nominalExpiresAt: typeof row.nominal_expires_at === "string" ? row.nominal_expires_at : null,
    clientOutcome: ["uploaded", "failed", "aborted"].includes(String(row.client_outcome))
      ? row.client_outcome as "uploaded" | "failed" | "aborted" : null,
    observedObject: normalizedObservation(row.observed_object),
  };
}

export class SupabaseUploadTrackingStore implements UploadTrackingStore {
  constructor(private readonly client: SupabaseClient) {}
  private async rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) {
      if (error.message === "upload_admission_paused") {
        throw new UploadTrackingError("UPLOAD_ADMISSION_PAUSED", "New uploads are paused for maintenance.", 503);
      }
      if (["upload_attempt_conflict", "upload_operation_conflict", "upload_control_conflict"].includes(error.message)) {
        throw new UploadTrackingError("UPLOAD_CONFLICT", "Upload state changed. Reconcile the existing attempt.", 409);
      }
      if (error.message === "upload_attempt_not_found") {
        throw new UploadTrackingError("UPLOAD_NOT_FOUND", "Upload attempt not found.", 404);
      }
      return unavailable();
    }
    return data;
  }

  async reserve(input: UploadAdmissionInput, bucket: string) {
    const result = await this.rpc("reserve_upload_attempt_v1", {
      p_id: input.attemptId, p_operation_id: input.operationId, p_owner_id: input.ownerId,
      p_purpose: input.purpose, p_content_type: input.contentType,
      p_expected_bytes: input.expectedBytes, p_extension: input.extension, p_bucket: bucket,
    });
    if (!result || typeof result !== "object" || typeof (result as { created?: unknown }).created !== "boolean") return unavailable();
    const row = result as { created: boolean; attempt: unknown };
    return { created: row.created, attempt: decodeAttempt(row.attempt) };
  }

  async publish(id: string, ownerId: string, nominalExpiresAt: string) {
    return decodeAttempt(await this.rpc("publish_upload_attempt_v1", {
      p_id: id, p_owner_id: ownerId, p_nominal_expires_at: nominalExpiresAt,
    }));
  }
  async noteIssuanceFailure(id: string, ownerId: string, code: "SIGNING_UNAVAILABLE" | "PUBLISH_UNCONFIRMED" | "ADMISSION_PAUSED") {
    await this.rpc("note_upload_issuance_failure_v1", { p_id: id, p_owner_id: ownerId, p_reason: code });
  }
  async findOwned(id: string, ownerId: string) {
    const value = await this.rpc("get_upload_attempt_v1", { p_id: id, p_owner_id: ownerId });
    return value === null ? null : decodeAttempt(value);
  }
  async observe(id: string, ownerId: string, input: Parameters<UploadTrackingStore["observe"]>[2]) {
    return decodeAttempt(await this.rpc("observe_upload_attempt_v1", {
      p_id: id, p_owner_id: ownerId, p_client_outcome: input.clientOutcome,
      p_metadata: input.object, p_error_code: input.errorCode,
    }));
  }

  /** Server-only operator method; no browser mutation endpoint is provided. */
  async setAdmission(paused: boolean, expectedGeneration: number, reason: string): Promise<unknown> {
    return this.rpc("set_upload_admission_v1", {
      p_paused: paused, p_expected_generation: expectedGeneration, p_reason: reason,
    });
  }
  async maintenanceSnapshot(): Promise<unknown> {
    return this.rpc("upload_maintenance_snapshot_v1");
  }
  async listAttempts(cursor: { admittedAt: string; id: string } | null = null, limit = 100): Promise<unknown> {
    return this.rpc("list_upload_attempts_v1", {
      p_after_at: cursor?.admittedAt ?? null, p_after_id: cursor?.id ?? null, p_limit: limit,
    });
  }
}

