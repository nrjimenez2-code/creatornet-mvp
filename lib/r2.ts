import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID!;

const r2Config = {
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
};

export const r2Client = new S3Client(r2Config);

// The browser supplies the bytes later. A bodyless presign must not calculate
// CRC32(empty) for those future bytes. Keep normal checksums on server uploads.
const r2UploadSigningClient = new S3Client({
  ...r2Config,
  requestChecksumCalculation: "WHEN_REQUIRED",
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
  contentType: string,
  size: number
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: size,
    IfNoneMatch: "*",
  });
  return getSignedUrl(r2UploadSigningClient, cmd, { expiresIn: 3600, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
}

/** Turns an R2 object key into its public CDN URL. */
export function r2PublicUrl(key: string): string {
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Size and type of an object already in the bucket, or null if it is not
 * there. POST /api/posts verifies the landed object in addition to the signed
 * upload contract, including uploads issued before that contract was enforced.
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

/**
 * Read only the first `length` bytes of an object, so a file's real format can
 * be identified without pulling a 500 MB video through this process. Uses a
 * Range request; returns null if the object cannot be read, so publication can
 * require verification before accepting the new post.
 */
export async function readR2ObjectPrefix(
  key: string,
  length: number
): Promise<Uint8Array | null> {
  try {
    const res = await r2Client.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: `bytes=0-${length - 1}` })
    );
    const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) return null;
    return await body.transformToByteArray();
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
