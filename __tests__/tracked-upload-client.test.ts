import { createTrackedUploader, TrackedUploadConflict } from "../lib/trackedUploadClient";
import type { SupabaseClient } from "@supabase/supabase-js";
function setup(provider:"r2"|"supabase"="r2") {
  let seq=0;
  const keys=new Map<string,string>();
  const request=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>(async(url,init)=>{
    if(url==="/api/upload/admit") {
      const input=JSON.parse(init!.body as string);const bucket=input.purpose==="avatar"?"avatars":"premium";
      const key=provider==="r2"?`videos/owner/launch_${input.attemptId}.mp4`:`owner/${input.attemptId}.mp4`;keys.set(input.attemptId,key);
      return Response.json({attemptId:input.attemptId,key,publicUrl:"https://media.invalid/file",capability:provider==="r2"?
        {provider,uploadUrl:"https://provider.invalid?signature=secret"}:{provider,token:"secret",key,bucket}});
    }
    const id=String(url).split("/")[3];return Response.json({objectObserved:true,key:keys.get(id)});
  });
  const deps={request,put:jest.fn<Promise<void>,[string,Blob,string,((loaded:number,total:number)=>void)?]>(async()=>{}),id:()=>`id-${++seq}`,wait:jest.fn(async()=>{})};
  const upload=createTrackedUploader(deps);
  const options={file:new Blob(["test"]),filename:"a.mp4",contentType:"video/mp4",purpose:"video" as const,ownerId:"owner"};
  return {deps,upload,options};
}
test("successful R2 upload is verified before use",async()=>{
  const f=setup();const result=await f.upload(f.options);expect(result.key).toContain("id-2");expect(f.deps.put).toHaveBeenCalledTimes(1);
  const admit=JSON.parse(f.deps.request.mock.calls[0][1]!.body as string);expect(admit.size).toBe(4);expect(admit.operationId).toBe("id-1");
});
test("retry uses a fresh attempt/key and reports old failure",async()=>{
  const f=setup();f.deps.put.mockRejectedValueOnce(new Error("disconnect"));await f.upload(f.options);
  const admissions=f.deps.request.mock.calls.filter(([url])=>url==="/api/upload/admit").map(([,init])=>JSON.parse(init!.body as string));
  expect(admissions).toHaveLength(2);expect(admissions[0].operationId).toBe(admissions[1].operationId);expect(admissions[0].attemptId).not.toBe(admissions[1].attemptId);
  expect(f.deps.request.mock.calls.some(([,init])=>init?.body===JSON.stringify({outcome:"failed"}))).toBe(true);
});
test("admission failure stops without provider writes",async()=>{
  const f=setup();f.deps.request.mockResolvedValueOnce(Response.json({error:"New uploads are paused for maintenance."},{status:503}));
  await expect(f.upload(f.options)).rejects.toThrow("paused");expect(f.deps.put).not.toHaveBeenCalled();expect(f.deps.request).toHaveBeenCalledTimes(1);
});
test("verification outage never reuploads, including explicit same-file retry",async()=>{
  const f=setup();const original=f.deps.request.getMockImplementation()!;
  f.deps.request.mockImplementation(async(url,init)=>url==="/api/upload/admit"?original(url,init):Response.json({error:"pending"},{status:503}));
  await expect(f.upload(f.options)).rejects.toThrow("verification is still pending");expect(f.deps.put).toHaveBeenCalledTimes(1);
  f.deps.request.mockImplementation(original);await f.upload(f.options);
  expect(f.deps.put).toHaveBeenCalledTimes(1);expect(f.deps.request.mock.calls.filter(([url])=>url==="/api/upload/admit")).toHaveLength(1);
});
test("concurrent same-file callers share one admission",async()=>{
  const f=setup();await Promise.all([f.upload(f.options),f.upload(f.options)]);expect(f.deps.put).toHaveBeenCalledTimes(1);
});
test.each(["premium","avatar"] as const)("%s uses only server-admitted signed uploads",async purpose=>{
  const f=setup("supabase");const uploadToSignedUrl=jest.fn(async()=>({error:null}));const from=jest.fn(()=>({uploadToSignedUrl}));
  await f.upload({...f.options,purpose,supabase:{storage:{from}} as unknown as SupabaseClient});
  expect(from).toHaveBeenCalledWith(purpose==="avatar"?"avatars":"premium");expect(uploadToSignedUrl).toHaveBeenCalledTimes(1);expect(f.deps.put).not.toHaveBeenCalled();
  expect(f.deps.request.mock.calls.every(([,init])=>!String(init?.body).includes("secret"))).toBe(true);
});

test('412 verifies the exact admission without another PUT or admission',async()=>{
  const f=setup();f.deps.put.mockRejectedValueOnce(new TrackedUploadConflict('conflict'));
  const result=await f.upload(f.options);
  expect(result.key).toBe('videos/owner/launch_id-2.mp4');
  expect(f.deps.put).toHaveBeenCalledTimes(1);
  expect(f.deps.request.mock.calls.map(([url])=>url)).toEqual(['/api/upload/admit','/api/upload/id-2/complete']);
  expect(JSON.parse(f.deps.request.mock.calls[1][1]!.body as string)).toEqual({outcome:'uploaded'});
});
test('412 verification outage retains original metadata for verification-only retry',async()=>{
  const f=setup(),original=f.deps.request.getMockImplementation()!;
  f.deps.put.mockRejectedValueOnce(new TrackedUploadConflict('conflict'));
  f.deps.request.mockImplementation(async(url,init)=>url==='/api/upload/admit'?original(url,init):Response.json({error:'pending'},{status:503}));
  await expect(f.upload(f.options)).rejects.toThrow('verification is still pending');
  f.deps.request.mockImplementation(original);await f.upload(f.options);
  expect(f.deps.put).toHaveBeenCalledTimes(1);
  expect(f.deps.request.mock.calls.filter(([url])=>url==='/api/upload/admit')).toHaveLength(1);
  expect(f.deps.request.mock.calls.slice(1).every(([url])=>url==='/api/upload/id-2/complete')).toBe(true);
});
test('public MIME is normalized for admission and conditional PUT',async()=>{
  const f=setup();await f.upload({...f.options,contentType:' VIDEO/MP4 '});
  expect(JSON.parse(f.deps.request.mock.calls[0][1]!.body as string)).toMatchObject({contentType:'video/mp4',uploadContract:'create-only-v1',size:4});
  expect(f.deps.put.mock.calls[0][2]).toBe('video/mp4');
});
