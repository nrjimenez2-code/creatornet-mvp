import { NextRequest } from "next/server";
import { keyForUpload, type UploadAttempt, type UploadAdmissionInput } from "@/lib/uploadTrackingProtocol";
const owner="11111111-1111-4111-8111-111111111111",attempt="33333333-3333-4333-8333-333333333333";

// Route fixture supplies an owned open store; actual SQL/closure races are
// independently exercised by the native upload-tracking checks.
const mockReserve=jest.fn(),mockPublish=jest.fn();
let mockTracked: Map<string,UploadAttempt>;
let mockPreviousUploadPause: string | undefined;
jest.mock('@/lib/uploadTrackingStore',()=>({SupabaseUploadTrackingStore:jest.fn(()=>({
  reserve:(...args:unknown[])=>mockReserve(...args),publish:(...args:unknown[])=>mockPublish(...args),noteIssuanceFailure:jest.fn(),
}))}));
function openTrackingFixture(){
  mockPreviousUploadPause=process.env.UPLOAD_ADMISSION_PAUSED;
  process.env.UPLOAD_ADMISSION_PAUSED='0';
  mockTracked=new Map();
  mockReserve.mockImplementation(async(input:UploadAdmissionInput,bucket:string)=>{
    const attempt:UploadAttempt={...input,provider:'r2',bucket,key:keyForUpload(input),admissionGeneration:1,state:'reserved',
      admittedAt:new Date().toISOString(),capabilityIssuedAt:null,nominalExpiresAt:null,clientOutcome:null,observedObject:null};
    mockTracked.set(input.attemptId,attempt);return {created:true,attempt};
  });
  mockPublish.mockImplementation(async(id:string,_owner:string,expiry:string)=>({...mockTracked.get(id)!,state:'capability_issued',nominalExpiresAt:expiry,capabilityIssuedAt:new Date().toISOString()}));
}
afterEach(()=>{
  if(mockPreviousUploadPause===undefined)delete process.env.UPLOAD_ADMISSION_PAUSED;
  else process.env.UPLOAD_ADMISSION_PAUSED=mockPreviousUploadPause;
});

import { MAX_VIDEO_BYTES, MAX_IMAGE_BYTES } from "@/lib/uploadPolicy";
const mockHead=jest.fn(),mockLegacy=jest.fn(),mockAdmit=jest.fn();
jest.mock("@/lib/legacyPublicUpload",()=>({hasLegacyPublicUploadReservation:(...args:unknown[])=>mockLegacy(...args)}));
const mockSign = jest.fn<Promise<string>, unknown[]>(async () => "https://upload.test/signed");
jest.mock("@/lib/supabaseClient", () => ({ createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: owner,email_confirmed_at:"2026-01-01",is_anonymous:false } } }) } }) }));
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{banned_at:null},error:null})})})})}}));
jest.mock("@/lib/r2", () => ({ R2_BUCKET:"media", headR2Object:(...args:unknown[])=>mockHead(...args), createPresignedUploadUrl: (...args: unknown[]) => mockSign(...args), r2PublicUrl: (key: string) => "https://media.test/" + key }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
import { POST as legacy } from "@/app/api/upload/presign/route";
import { POST } from "@/app/api/upload/admit/route";
const request = (body: Record<string, unknown>) => POST(new NextRequest("https://app.test/api/upload/admit", { method: "POST", body: JSON.stringify({uploadContract:"create-only-v1",purpose:body.folder==="thumbnails"?"thumbnail":"video",attemptId:attempt,...body}) }));
const legacyRequest = (body: Record<string, unknown>) => legacy(new NextRequest("https://app.test/api/upload/presign", { method: "POST", body: JSON.stringify({uploadContract:"create-only-v1",...body}) }));
beforeEach(() => { jest.clearAllMocks();openTrackingFixture();mockAdmit.mockImplementation(async(...args:unknown[])=>({resource:(args[3] as {resource?:string}|undefined)?.resource??null,reused:false})); });
test.each([undefined, null, "123", 0, -1, 1.5, MAX_VIDEO_BYTES + 1])("rejects video size %p before signing", async size => {
  expect((await request({ filename: "test.mp4", contentType: "video/mp4", folder: "videos", size })).status).toBe(400);
  expect(mockSign).not.toHaveBeenCalled();expect(mockReserve).not.toHaveBeenCalled();
});
test("rejects an oversized thumbnail and forbidden MIME before signing", async () => {
  expect((await request({ filename: "test.jpg", contentType: "image/jpeg", folder: "thumbnails", size: MAX_IMAGE_BYTES + 1 })).status).toBe(400);
  expect((await request({ filename: "test.jpg", contentType: "text/html", folder: "thumbnails", size: 100 })).status).toBe(400);
  expect(mockSign).not.toHaveBeenCalled();expect(mockReserve).not.toHaveBeenCalled();
});
test.each([["videos", "video/mp4", MAX_VIDEO_BYTES], ["thumbnails", "image/jpeg", MAX_IMAGE_BYTES]])("signs the legitimate %s maximum", async (folder, contentType, size) => {
  expect((await request({ filename: "test.mp4", contentType, folder, size })).status).toBe(200);
  expect(mockSign).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${folder}/${owner}/launch_${attempt}\\.mp4$`)), contentType, size);
  expect(mockReserve).toHaveBeenCalledTimes(1);expect(mockPublish).toHaveBeenCalledTimes(1);
});
// Admission behavior is covered by durable-abuse-* tests; keep this suite's domain fixtures.
jest.mock("@/lib/abuse/admission", () => ({
  admitRequest: (...args:unknown[])=>mockAdmit(...args),
  admissionResponse: () => null,
}));

test.each([['videos','video/mp4',MAX_VIDEO_BYTES],['thumbnails','image/jpeg',MAX_IMAGE_BYTES]])('fresh legacy %s maximum requires refresh without signing',async(folder,contentType,size)=>{
  expect((await legacyRequest({filename:'test.mp4',folder,contentType,size})).status).toBe(409);expect(mockSign).not.toHaveBeenCalled();expect(mockReserve).not.toHaveBeenCalled();
});
test('legacy size and MIME refusal remain before any signing',async()=>{
  expect((await legacyRequest({filename:'a.mp4',folder:'videos',contentType:'video/mp4',size:MAX_VIDEO_BYTES+1})).status).toBe(400);
  expect((await legacyRequest({filename:'a.jpg',folder:'thumbnails',contentType:'text/html',size:100})).status).toBe(400);expect(mockSign).not.toHaveBeenCalled();
});

const originalLegacyOperation="22222222-2222-4222-8222-222222222222";
test.each([undefined,null,"123",0,-1,1.5,MAX_VIDEO_BYTES+1])("legacy verification rejects video size %p before lookup or provider work",async size=>{
  expect((await legacyRequest({filename:"a.mp4",folder:"videos",contentType:"video/mp4",size,verifyExisting:true,operationId:originalLegacyOperation})).status).toBe(400);
  expect(mockLegacy).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockReserve).not.toHaveBeenCalled();expect(mockPublish).not.toHaveBeenCalled();
});
test("legacy verification rejects oversized thumbnails before lookup or provider work",async()=>{
  expect((await legacyRequest({filename:"a.jpg",folder:"thumbnails",contentType:"image/jpeg",size:MAX_IMAGE_BYTES+1,verifyExisting:true,operationId:originalLegacyOperation})).status).toBe(400);
  expect(mockLegacy).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockReserve).not.toHaveBeenCalled();expect(mockPublish).not.toHaveBeenCalled();
});
