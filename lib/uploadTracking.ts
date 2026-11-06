import "server-only";
import {
  keyForUpload,
  normalizedObservation,
  observationMatches,
  unresolvedUploadReasons,
  UploadTrackingError,
  type ClientUploadOutcome,
  type UploadAdmissionInput,
  type UploadAttempt,
  type UploadObjectObservation,
  type UploadProvider,
  type UploadPurpose,
} from "./uploadTrackingProtocol";

export interface UploadTrackingStore {
  reserve(input: UploadAdmissionInput, bucket: string): Promise<{ created: boolean; attempt: UploadAttempt }>;
  publish(id: string, ownerId: string, nominalExpiresAt: string): Promise<UploadAttempt>;
  noteIssuanceFailure(id: string, ownerId: string, code: "SIGNING_UNAVAILABLE" | "PUBLISH_UNCONFIRMED" | "ADMISSION_PAUSED"): Promise<void>;
  findOwned(id: string, ownerId: string): Promise<UploadAttempt | null>;
  observe(id: string, ownerId: string, input: {
    clientOutcome: ClientUploadOutcome | null;
    object: UploadObjectObservation | null;
    errorCode: "VERIFICATION_UNAVAILABLE" | "OBJECT_NOT_FOUND" | "OBJECT_MISMATCH" | "BINDING_MISMATCH" | null;
  }): Promise<UploadAttempt>;
}

export type UploadCapability =
  | { provider: "r2"; uploadUrl: string; publicUrl: string; nominalExpiresAt: string }
  | { provider: "supabase"; token: string; key: string; bucket: string; publicUrl: string | null; nominalExpiresAt: string };

export interface UploadTrackingProviders {
  bucket(purpose: UploadPurpose): string;
  sign(attempt: UploadAttempt): Promise<UploadCapability>;
  inspect(attempt: UploadAttempt): Promise<unknown | null>;
  publicUrl(attempt: UploadAttempt): string | null;
}

export interface OwnedUploadStatus {
  attemptId: string;
  operationId: string;
  purpose: UploadPurpose;
  provider: UploadProvider;
  key: string;
  bucket: string;
  state: UploadAttempt["state"];
  objectObserved: boolean;
  clientOutcome: ClientUploadOutcome | null;
  publicUrl: string | null;
  unresolvedReasons: string[];
  providerWriteQuiescenceProven: false;
}

export class UploadTrackingRuntime {
  constructor(
    private readonly store: UploadTrackingStore,
    private readonly providers: UploadTrackingProviders,
    private readonly admissionOverridePaused: () => boolean = () => false,
  ) {}

  private ownedStatus(attempt: UploadAttempt): OwnedUploadStatus {
    return {
      attemptId: attempt.attemptId,
      operationId: attempt.operationId,
      purpose: attempt.purpose,
      provider: attempt.provider,
      key: attempt.key,
      bucket: attempt.bucket,
      state: attempt.state,
      objectObserved: attempt.state === "object_observed",
      clientOutcome: attempt.clientOutcome,
      publicUrl: this.providers.publicUrl(attempt),
      unresolvedReasons: unresolvedUploadReasons(attempt),
      providerWriteQuiescenceProven: false,
    };
  }

  async begin(input: UploadAdmissionInput): Promise<OwnedUploadStatus & { capability: UploadCapability }> {
    if (this.admissionOverridePaused()) {
      throw new UploadTrackingError("UPLOAD_ADMISSION_PAUSED", "New uploads are paused for maintenance.", 503);
    }
    const reserved = await this.store.reserve(input, this.providers.bucket(input.purpose));
    if (!reserved.created) {
      // Replaying a request must not mint a new, longer-lived capability.
      throw new UploadTrackingError("UPLOAD_ATTEMPT_EXISTS", "This upload attempt already exists. Reconcile it or start a new attempt.", 409);
    }
    const attempt = reserved.attempt;
    if (attempt.ownerId !== input.ownerId || attempt.attemptId !== input.attemptId ||
        attempt.key !== keyForUpload(input)) {
      throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Uploads are temporarily unavailable.", 503);
    }

    let capability: UploadCapability;
    try {
      capability = await this.providers.sign(attempt);
      if (capability.provider !== attempt.provider ||
          !Number.isFinite(Date.parse(capability.nominalExpiresAt)) ||
          (capability.provider === "supabase" &&
            (capability.key !== attempt.key || capability.bucket !== attempt.bucket || !capability.token)) ||
          (capability.provider === "r2" && (!capability.uploadUrl || !capability.publicUrl))) {
        throw new Error("invalid_provider_capability");
      }
    } catch {
      await this.store.noteIssuanceFailure(attempt.attemptId, input.ownerId, "SIGNING_UNAVAILABLE").catch(() => undefined);
      throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Upload authorization could not be confirmed. The attempt remains tracked.", 503);
    }

    let published: UploadAttempt;
    try {
      // This transaction is the publication decision, serialized with pause.
      // The URL/token stays in memory and is never supplied to the store.
      published = await this.store.publish(attempt.attemptId, input.ownerId, capability.nominalExpiresAt);
    } catch (error) {
      const paused = error instanceof UploadTrackingError && error.code === "UPLOAD_ADMISSION_PAUSED";
      await this.store.noteIssuanceFailure(
        attempt.attemptId, input.ownerId, paused ? "ADMISSION_PAUSED" : "PUBLISH_UNCONFIRMED",
      ).catch(() => undefined);
      if (paused) throw error;
      throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Upload authorization could not be confirmed. The attempt remains tracked.", 503);
    }
    if (published.ownerId !== input.ownerId || published.key !== attempt.key ||
        published.state !== "capability_issued") {
      throw new UploadTrackingError("UPLOAD_UNAVAILABLE", "Upload authorization could not be confirmed.", 503);
    }
    return { ...this.ownedStatus(published), capability };
  }

  async status(id: string, ownerId: string): Promise<OwnedUploadStatus> {
    const attempt = await this.store.findOwned(id, ownerId);
    if (!attempt || attempt.ownerId !== ownerId) {
      throw new UploadTrackingError("UPLOAD_NOT_FOUND", "Upload attempt not found.", 404);
    }
    return this.ownedStatus(attempt);
  }

  async complete(
    id: string, ownerId: string, clientOutcome: ClientUploadOutcome | null,
  ): Promise<{ status: number; upload: OwnedUploadStatus }> {
    // Completion/reconciliation deliberately has no admission-pause check.
    const attempt = await this.store.findOwned(id, ownerId);
    if (!attempt || attempt.ownerId !== ownerId) {
      throw new UploadTrackingError("UPLOAD_NOT_FOUND", "Upload attempt not found.", 404);
    }
    if (clientOutcome === "failed" || clientOutcome === "aborted") {
      const updated = await this.store.observe(id, ownerId, { clientOutcome, object: null, errorCode: null });
      return { status: 202, upload: this.ownedStatus(updated) };
    }
    let observed: unknown | null;
    try {
      observed = await this.providers.inspect(attempt);
    } catch {
      await this.store.observe(id, ownerId, {
        clientOutcome, object: null, errorCode: "VERIFICATION_UNAVAILABLE",
      });
      throw new UploadTrackingError("UPLOAD_VERIFICATION_PENDING", "Upload verification is unavailable. This attempt remains unresolved.", 503);
    }
    if (observed === null) {
      const updated = await this.store.observe(id, ownerId, {
        clientOutcome, object: null, errorCode: "OBJECT_NOT_FOUND",
      });
      return { status: 202, upload: this.ownedStatus(updated) };
    }
    const object = normalizedObservation(observed);
    if (!object) {
      await this.store.observe(id, ownerId, {
        clientOutcome, object: null, errorCode: "VERIFICATION_UNAVAILABLE",
      });
      throw new UploadTrackingError("UPLOAD_VERIFICATION_PENDING", "Upload metadata could not be verified.", 503);
    }
    const matches = observationMatches(attempt, object);
    const updated = await this.store.observe(id, ownerId, {
      clientOutcome, object, errorCode: matches ? null : "OBJECT_MISMATCH",
    });
    if (!matches || updated.state === "object_mismatch") {
      throw new UploadTrackingError("UPLOAD_OBJECT_MISMATCH", "The uploaded object does not match this attempt.", 409);
    }
    return { status: 200, upload: this.ownedStatus(updated) };
  }
}

