import "server-only";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPresignedUploadUrl, R2_BUCKET, r2Client, r2PublicUrl } from "./r2";
import { bucketForPurpose, type UploadAttempt, type UploadPurpose } from "./uploadTrackingProtocol";
import type { UploadCapability, UploadTrackingProviders } from "./uploadTracking";

export class StorageUploadTrackingProviders implements UploadTrackingProviders {
  constructor(private readonly actor: SupabaseClient, private readonly inspector: SupabaseClient) {}
  bucket(purpose: UploadPurpose): string { return bucketForPurpose(purpose, R2_BUCKET); }
  private assertBinding(attempt: UploadAttempt) {
    if (this.bucket(attempt.purpose) !== attempt.bucket ||
        attempt.provider !== (attempt.purpose === "video" || attempt.purpose === "thumbnail" ? "r2" : "supabase")) {
      throw new Error("upload_binding_unavailable");
    }
  }
  publicUrl(attempt: UploadAttempt): string | null {
    this.assertBinding(attempt);
    if (attempt.provider === "r2") return r2PublicUrl(attempt.key);
    if (attempt.purpose === "avatar") return this.actor.storage.from("avatars").getPublicUrl(attempt.key).data.publicUrl;
    return null;
  }
  async sign(attempt: UploadAttempt): Promise<UploadCapability> {
    this.assertBinding(attempt);
    if (attempt.provider === "r2") {
      if (!Number.isSafeInteger(attempt.expectedBytes) || (attempt.expectedBytes ?? 0) <= 0) {
        throw new Error("upload_size_unavailable");
      }
      return {
        provider: "r2", uploadUrl: await createPresignedUploadUrl(attempt.key, attempt.contentType, attempt.expectedBytes!),
        publicUrl: r2PublicUrl(attempt.key), nominalExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    }
    // Preserve the user's existing Storage permissions. The service role must
    // never sign on their behalf or broaden their old permissive policies.
    const { data, error } = await this.actor.storage.from(attempt.bucket).createSignedUploadUrl(attempt.key, { upsert: false });
    if (error || !data || data.path !== attempt.key || !data.token) throw new Error("upload_signing_unavailable");
    return {
      provider: "supabase", token: data.token, key: attempt.key, bucket: attempt.bucket,
      publicUrl: this.publicUrl(attempt), nominalExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    };
  }
  async inspect(attempt: UploadAttempt): Promise<unknown | null> {
    this.assertBinding(attempt);
    if (attempt.provider === "r2") {
      try {
        const object = await r2Client.send(new HeadObjectCommand({ Bucket: attempt.bucket, Key: attempt.key }));
        return { size: object.ContentLength, contentType: object.ContentType, etag: object.ETag ?? null, version: object.VersionId ?? null };
      } catch (error) {
        const code = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (code === 404) return null;
        throw new Error("upload_inspection_unavailable");
      }
    }
    const { data, error } = await this.inspector.storage.from(attempt.bucket).info(attempt.key);
    if (error) {
      if (String((error as { statusCode?: unknown }).statusCode) === "404") return null;
      throw new Error("upload_inspection_unavailable");
    }
    if (!data) throw new Error("upload_inspection_unavailable");
    return { size: data.size, contentType: data.contentType, etag: data.etag ?? null, version: data.version ?? null };
  }
}
