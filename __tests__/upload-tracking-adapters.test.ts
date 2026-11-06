import type { SupabaseClient } from "@supabase/supabase-js";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { StorageUploadTrackingProviders } from "@/lib/uploadTrackingProviders";
import { SupabaseUploadTrackingStore } from "@/lib/uploadTrackingStore";
import { keyForUpload, parseUploadAdmission, type UploadAttempt, type UploadPurpose } from "@/lib/uploadTrackingProtocol";

const mockHead = jest.fn(), mockSignR2 = jest.fn();
jest.mock("@/lib/r2", () => ({
  R2_BUCKET: "media", r2Client: { send: (...args: unknown[]) => mockHead(...args) },
  createPresignedUploadUrl: (...args: unknown[]) => mockSignR2(...args),
  r2PublicUrl: (key: string) => `https://cdn.test/${key}`,
}));

function attempt(purpose: UploadPurpose): UploadAttempt {
  const input = parseUploadAdmission({ purpose, filename: purpose === "avatar" ? "photo.png" : "clip.mp4",
    contentType: purpose === "avatar" ? "image/png" : "video/mp4", size: 10,
  }, "a1111111-1111-4111-8111-111111111111", () => "b2222222-2222-4222-8222-222222222222");
  return { ...input, provider: purpose === "video" ? "r2" : "supabase", bucket: purpose === "video" ? "media" : purpose === "avatar" ? "avatars" : "premium",
    key: keyForUpload(input), admissionGeneration: 1, state: "reserved", admittedAt: "2026-11-04T00:00:00Z",
    capabilityIssuedAt: null, nominalExpiresAt: null, clientOutcome: null, observedObject: null };
}

function fixture() {
  const sign = jest.fn(), info = jest.fn();
  const actor = { storage: { from: jest.fn(() => ({ createSignedUploadUrl: sign, getPublicUrl: (key: string) => ({ data: { publicUrl: `https://cdn.test/${key}` } }) })) } };
  const inspector = { storage: { from: jest.fn(() => ({ info })) } };
  return { sign, info, actor, inspector, providers: new StorageUploadTrackingProviders(actor as unknown as SupabaseClient, inspector as unknown as SupabaseClient) };
}
beforeEach(() => jest.clearAllMocks());

test.each(["premium", "avatar"] as const)("%s signs only as actor and inspects only the exact object as inspector", async purpose => {
  const f = fixture(), a = attempt(purpose);
  f.sign.mockResolvedValue({ data: { path: a.key, token: "mock-token" }, error: null });
  const signed = await f.providers.sign(a);
  expect(signed).toMatchObject({ provider: "supabase", key: a.key, bucket: a.bucket, token: "mock-token" });
  expect(f.actor.storage.from).toHaveBeenCalledWith(a.bucket);
  expect(f.sign).toHaveBeenCalledWith(a.key, { upsert: false }); expect(f.inspector.storage.from).not.toHaveBeenCalled();
  f.info.mockResolvedValue({ data: { size: 10, contentType: a.contentType, etag: "first", version: "v1", token: "discarded" }, error: null });
  expect(await f.providers.inspect(a)).toEqual({ size: 10, contentType: a.contentType, etag: "first", version: "v1" });
  expect(f.inspector.storage.from).toHaveBeenCalledWith(a.bucket); expect(f.info).toHaveBeenCalledWith(a.key);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

test("mismatched signing response fails without any inspector signing fallback", async () => {
  const f = fixture(), a = attempt("premium");
  f.sign.mockResolvedValue({ data: { path: "wrong-key", token: "mock-token" }, error: null });
  await expect(f.providers.sign(a)).rejects.toThrow("upload_signing_unavailable");
  expect(f.inspector.storage.from).not.toHaveBeenCalled();
});

test("R2 HEAD uses exact bucket/key and distinguishes absence from provider failure", async () => {
  const f = fixture(), a = attempt("video");
  mockHead.mockResolvedValueOnce({ ContentLength: 10, ContentType: "video/mp4", ETag: "first", VersionId: "v1" });
  expect(await f.providers.inspect(a)).toEqual({ size: 10, contentType: "video/mp4", etag: "first", version: "v1" });
  expect(mockHead.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  expect(mockHead.mock.calls[0][0].input).toMatchObject({ Bucket: "media", Key: a.key });
  mockHead.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
  expect(await f.providers.inspect(a)).toBeNull();
  mockHead.mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 }, message: "provider-private-detail" });
  await expect(f.providers.inspect(a)).rejects.toThrow("upload_inspection_unavailable");
});

test("Supabase exact info distinguishes absence from provider failure", async () => {
  const f = fixture(), a = attempt("premium");
  f.info.mockResolvedValueOnce({ data: null, error: { statusCode: "404" } });
  expect(await f.providers.inspect(a)).toBeNull();
  f.info.mockResolvedValueOnce({ data: null, error: { statusCode: "503" } });
  await expect(f.providers.inspect(a)).rejects.toThrow("upload_inspection_unavailable");
});

test("store forwards exact microsecond cursor and bounded limit without Date conversion", async () => {
  const data = { attempts: [], nextCursor: null };
  const rpc = jest.fn().mockResolvedValue({ data, error: null });
  const store = new SupabaseUploadTrackingStore({ rpc } as unknown as SupabaseClient);
  const cursor = { admittedAt: "2026-11-04T00:00:00.123456+00:00", id: "b2222222-2222-4222-8222-222222222222" };
  expect(await store.listAttempts(cursor, 30)).toBe(data);
  expect(rpc).toHaveBeenLastCalledWith("list_upload_attempts_v1", { p_after_at: cursor.admittedAt, p_after_id: cursor.id, p_limit: 30 });
  await store.listAttempts();
  expect(rpc).toHaveBeenLastCalledWith("list_upload_attempts_v1", { p_after_at: null, p_after_id: null, p_limit: 100 });
});

test('R2 signing binds the exact positive expected size',async()=>{
  const f=fixture(),a=attempt('video');mockSignR2.mockResolvedValue('https://signed.test');
  await f.providers.sign(a);expect(mockSignR2).toHaveBeenCalledWith(a.key,a.contentType,10);
});
test.each([null,0,-1,1.2,Number.MAX_SAFE_INTEGER+1])('R2 refuses invalid expected size %p before signing',async size=>{
  const f=fixture(),a={...attempt('video'),expectedBytes:size};
  await expect(f.providers.sign(a)).rejects.toThrow('upload_size_unavailable');expect(mockSignR2).not.toHaveBeenCalled();
});
