import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID!;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});

export const R2_BUCKET = process.env.R2_BUCKET_NAME ?? "creatornet-media";
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

/**
 * Returns a presigned PUT URL valid for 5 minutes.
 * The client uploads the file directly to R2 — no proxying through Vercel.
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
  return getSignedUrl(r2Client, cmd, { expiresIn: 300 });
}

/** Turns an R2 object key into its public CDN URL. */
export function r2PublicUrl(key: string): string {
  return `${R2_PUBLIC_URL}/${key}`;
}
