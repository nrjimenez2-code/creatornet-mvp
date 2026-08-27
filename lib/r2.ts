import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID!;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export const R2_BUCKET = process.env.R2_BUCKET_NAME ?? "creatornet-media";
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

/**
 * Returns a presigned PUT URL valid for 1 hour. The client uploads the file
 * directly to R2 — no proxying through Vercel. The signature must outlive the
 * whole upload: a 500MB video on a slow mobile connection can easily take
 * longer than the old 5-minute window, which killed every such upload.
 */
export async function createPresignedUploadUrl(
  key: string,
  contentType: string
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2Client, cmd, { expiresIn: 3600 });
}

/** Turns an R2 object key into its public CDN URL. */
export function r2PublicUrl(key: string): string {
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Size and type of an object already in the bucket, or null if it is not
 * there. Used by POST /api/posts to refuse a post whose video blew past the
 * size cap: a presigned PUT cannot enforce a length without the browser
 * sending one up front, so the check happens once the bytes have landed.
 */
export async function headR2Object(
  key: string
): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const res = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
  } catch {
    return null;
  }
}

/** Remove an object we decided not to keep. Best effort. */
export async function deleteR2Object(key: string): Promise<void> {
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch {
    // nothing to do; lifecycle rules can sweep it
  }
}

/** Inverse of r2PublicUrl: the key for a URL under our public origin, or null. */
export function r2KeyFromPublicUrl(url: string): string | null {
  const base = `${R2_PUBLIC_URL}/`;
  return url.startsWith(base) ? url.slice(base.length).split("?")[0] : null;
}
