import { NextRequest } from "next/server";
import { MAX_VIDEO_BYTES, MAX_IMAGE_BYTES } from "@/lib/uploadPolicy";
const mockSign = jest.fn<Promise<string>, unknown[]>(async () => "https://upload.test/signed");
jest.mock("@/lib/supabaseClient", () => ({ createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "creator",email_confirmed_at:"2026-01-01",is_anonymous:false } } }) } }) }));
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{banned_at:null},error:null})})})})}}));
jest.mock("@/lib/r2", () => ({ createPresignedUploadUrl: (...args: unknown[]) => mockSign(...args), r2PublicUrl: (key: string) => "https://media.test/" + key }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
import { POST } from "@/app/api/upload/presign/route";
const request = (body: Record<string, unknown>) => POST(new NextRequest("https://app.test/api/upload/presign", { method: "POST", body: JSON.stringify({uploadContract:"create-only-v1",...body}) }));
beforeEach(() => mockSign.mockClear());
test.each([undefined, null, "123", 0, -1, 1.5, MAX_VIDEO_BYTES + 1])("rejects video size %p before signing", async size => {
  expect((await request({ filename: "test.mp4", contentType: "video/mp4", folder: "videos", size })).status).toBe(400);
  expect(mockSign).not.toHaveBeenCalled();
});
test("rejects an oversized thumbnail and forbidden MIME before signing", async () => {
  expect((await request({ filename: "test.jpg", contentType: "image/jpeg", folder: "thumbnails", size: MAX_IMAGE_BYTES + 1 })).status).toBe(400);
  expect((await request({ filename: "test.jpg", contentType: "text/html", folder: "thumbnails", size: 100 })).status).toBe(400);
  expect(mockSign).not.toHaveBeenCalled();
});
test.each([["videos", "video/mp4", MAX_VIDEO_BYTES], ["thumbnails", "image/jpeg", MAX_IMAGE_BYTES]])("signs the legitimate %s maximum", async (folder, contentType, size) => {
  expect((await request({ filename: "test.mp4", contentType, folder, size })).status).toBe(200);
  expect(mockSign).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${folder}/creator/launch_[a-f0-9-]+\\.mp4$`)), contentType, size);
});
// Admission behavior is covered by durable-abuse-* tests; keep this suite's domain fixtures.
jest.mock("@/lib/abuse/admission", () => ({
  admitRequest: jest.fn(async (...args: unknown[]) => ({resource:(args[3] as {resource?:string}|undefined)?.resource??null,reused:false})),
  admissionResponse: () => null,
}));
