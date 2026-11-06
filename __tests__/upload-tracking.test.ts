import { parseUploadAdmission, normalizedObservation, keyForUpload, unresolvedUploadReasons, type UploadAttempt } from "../lib/uploadTrackingProtocol";
import { UploadTrackingRuntime, type UploadTrackingStore, type UploadTrackingProviders } from "../lib/uploadTracking";

const OWNER="a1111111-1111-4111-8111-111111111111";
const ID="b2222222-2222-4222-8222-222222222222";
const input=()=>parseUploadAdmission({ purpose:"video", filename:"clip.mp4", contentType:"video/mp4", size:10, attemptId:ID },OWNER,()=>ID);
function fixture() {
  const i=input();
  const attempt: UploadAttempt={...i,provider:"r2",bucket:"media",key:keyForUpload(i),admissionGeneration:1,state:"reserved",admittedAt:new Date().toISOString(),capabilityIssuedAt:null,nominalExpiresAt:null,clientOutcome:null,observedObject:null};
  const store: jest.Mocked<UploadTrackingStore>={
    reserve:jest.fn<ReturnType<UploadTrackingStore["reserve"]>,Parameters<UploadTrackingStore["reserve"]>>(async()=>({created:true,attempt:{...attempt}})),
    publish:jest.fn<ReturnType<UploadTrackingStore["publish"]>,Parameters<UploadTrackingStore["publish"]>>(async()=>({...attempt,state:"capability_issued",capabilityIssuedAt:new Date().toISOString()})),
    noteIssuanceFailure:jest.fn<ReturnType<UploadTrackingStore["noteIssuanceFailure"]>,Parameters<UploadTrackingStore["noteIssuanceFailure"]>>(async()=>{}),findOwned:jest.fn<ReturnType<UploadTrackingStore["findOwned"]>,Parameters<UploadTrackingStore["findOwned"]>>(async()=>({...attempt})),
    observe:jest.fn<ReturnType<UploadTrackingStore["observe"]>,Parameters<UploadTrackingStore["observe"]>>(async(_id,_owner,value)=>({...attempt,clientOutcome:value.clientOutcome,state:value.object?"object_observed":"verification_unavailable",observedObject:value.object})),
  };
  const providers: jest.Mocked<UploadTrackingProviders>={bucket:jest.fn<ReturnType<UploadTrackingProviders["bucket"]>,Parameters<UploadTrackingProviders["bucket"]>>(()=>"media"),publicUrl:jest.fn<ReturnType<UploadTrackingProviders["publicUrl"]>,Parameters<UploadTrackingProviders["publicUrl"]>>(()=>"https://media.invalid/clip"),
    sign:jest.fn<ReturnType<UploadTrackingProviders["sign"]>,Parameters<UploadTrackingProviders["sign"]>>(async()=>({provider:"r2",uploadUrl:"https://provider.invalid/?signature=secret",publicUrl:"https://media.invalid/clip",nominalExpiresAt:new Date(Date.now()+3600_000).toISOString()})),
    inspect:jest.fn<ReturnType<UploadTrackingProviders["inspect"]>,Parameters<UploadTrackingProviders["inspect"]>>(async()=>({size:10,contentType:"video/mp4",etag:"abc",version:null})),
  };
  return {attempt,store,providers,runtime:new UploadTrackingRuntime(store,providers)};
}
describe("upload admission protocol",()=>{
  test.each([undefined,null,0,-1,1.1,Number.MAX_SAFE_INTEGER+1,"10"])("rejects strict size %p",size=>{
    expect(()=>parseUploadAdmission({purpose:"video",filename:"a.mp4",contentType:"video/mp4",size},OWNER,()=>ID)).toThrow();
  });
  test.each(['video','thumbnail','premium','avatar'])('every %s admission requires known size',purpose=>{
    expect(()=>parseUploadAdmission({purpose,filename:'a.mp4',contentType:purpose==='thumbnail'||purpose==='avatar'?'image/png':'video/mp4'},OWNER,()=>ID)).toThrow();
  });
  test.each([
    ['video','videos/'+OWNER+'/launch_'+ID+'.mp4'],
    ['thumbnail','thumbnails/'+OWNER+'/launch_'+ID+'.png'],
    ['premium',OWNER+'/'+ID+'.mp4'],['avatar',OWNER+'/'+ID+'.png'],
  ] as const)('literal %s key preserves its provider namespace',(purpose,expected)=>{
    const image=purpose==='thumbnail'||purpose==='avatar';
    const value=parseUploadAdmission({purpose,filename:image?'a.png':'a.mp4',contentType:image?'image/png':'video/mp4',size:10,attemptId:ID},OWNER,()=>ID);
    expect(keyForUpload(value)).toBe(expected);
  });
  test("canonicalizes UUIDs and constrains key",()=>{
    const value=parseUploadAdmission({purpose:"avatar",filename:"../../x.PNG",contentType:"IMAGE/PNG",size:5,attemptId:ID.toUpperCase()},OWNER.toUpperCase(),()=>ID);
    expect(value.ownerId).toBe(OWNER);expect(value.attemptId).toBe(ID);expect(keyForUpload(value)).toBe(`${OWNER}/${ID}.png`);
  });
  test.each(["video","thumbnail","avatar"])("enforces %s limits/types",purpose=>{
    expect(()=>parseUploadAdmission({purpose,filename:"a.mp4",contentType:"text/html",size:10},OWNER,()=>ID)).toThrow();
    expect(()=>parseUploadAdmission({purpose,filename:"a.mp4",contentType:purpose==="video"?"video/mp4":"image/png",size:600*1024*1024},OWNER,()=>ID)).toThrow();
  });
  test("preserves premium entitlement without a new small size cap",()=>{
    const value=parseUploadAdmission({purpose:"premium",filename:"guide.pdf",contentType:"application/pdf",size:1024**3},OWNER,()=>ID);
    expect(value.expectedBytes).toBe(1024**3);expect(value.extension).toBe("pdf");
  });
  test("normalizes trusted provider metadata without extra fields",()=>{
    expect(normalizedObservation({size:10,contentType:"VIDEO/MP4; charset=binary",token:"never-store"})).toEqual({size:10,contentType:"video/mp4",etag:null,version:null});
    expect(normalizedObservation({contentType:"video/mp4"})).toBeNull();
  });
});
describe("durable capability publication and reconciliation",()=>{
  test("reserves before signing and publishes before returning",async()=>{
    const f=fixture();const result=await f.runtime.begin(input());
    expect(f.store.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.providers.sign.mock.invocationCallOrder[0]);
    expect(f.providers.sign.mock.invocationCallOrder[0]).toBeLessThan(f.store.publish.mock.invocationCallOrder[0]);
    expect(result.capability.provider).toBe("r2");expect(JSON.stringify(f.store.publish.mock.calls)).not.toContain("secret");
  });
  test("failed reservation releases no provider capability",async()=>{
    const f=fixture();f.store.reserve.mockRejectedValue(new Error("db"));await expect(f.runtime.begin(input())).rejects.toThrow();expect(f.providers.sign).not.toHaveBeenCalled();
  });
  test("same-attempt replay does not re-sign",async()=>{
    const f=fixture();f.store.reserve.mockResolvedValue({created:false,attempt:f.attempt});await expect(f.runtime.begin(input())).rejects.toMatchObject({status:409});expect(f.providers.sign).not.toHaveBeenCalled();
  });
  test("sign failure preserves unresolved reservation and never publishes",async()=>{
    const f=fixture();f.providers.sign.mockRejectedValue(new Error("https://secret.invalid?token=sensitive"));
    await expect(f.runtime.begin(input())).rejects.toMatchObject({code:"UPLOAD_UNAVAILABLE"});expect(f.store.publish).not.toHaveBeenCalled();
    expect(f.store.noteIssuanceFailure).toHaveBeenCalledWith(ID,OWNER,"SIGNING_UNAVAILABLE");
  });
  test("unknown publication result withholds capability",async()=>{
    const f=fixture();f.store.publish.mockRejectedValue(new Error("timeout"));await expect(f.runtime.begin(input())).rejects.toMatchObject({status:503});
    expect(f.store.noteIssuanceFailure).toHaveBeenCalledWith(ID,OWNER,"PUBLISH_UNCONFIRMED");
  });
  test("emergency pause denies only admission",async()=>{
    const f=fixture();const r=new UploadTrackingRuntime(f.store,f.providers,()=>true);
    await expect(r.begin(input())).rejects.toMatchObject({code:"UPLOAD_ADMISSION_PAUSED"});expect(f.store.reserve).not.toHaveBeenCalled();
    expect((await r.complete(ID,OWNER,"uploaded")).status).toBe(200);
  });
  test("another owner cannot inspect or complete an attempt",async()=>{
    const f=fixture();f.store.findOwned.mockResolvedValue({...f.attempt,ownerId:ID});
    await expect(f.runtime.status(ID,OWNER)).rejects.toMatchObject({status:404});
    await expect(f.runtime.complete(ID,OWNER,"uploaded")).rejects.toMatchObject({status:404});expect(f.providers.inspect).not.toHaveBeenCalled();
  });
  test.each(["failed","aborted"] as const)("%s report remains unresolved",async outcome=>{
    const f=fixture();const result=await f.runtime.complete(ID,OWNER,outcome);
    expect(result.status).toBe(202);expect(result.upload.providerWriteQuiescenceProven).toBe(false);expect(f.providers.inspect).not.toHaveBeenCalled();
  });
  test("missing object is pending, not observed",async()=>{
    const f=fixture();f.providers.inspect.mockResolvedValue(null);expect((await f.runtime.complete(ID,OWNER,"uploaded")).status).toBe(202);
  });
  test("provider outage records verification unavailable",async()=>{
    const f=fixture();f.providers.inspect.mockRejectedValue(new Error("outage"));await expect(f.runtime.complete(ID,OWNER,"uploaded")).rejects.toMatchObject({status:503});
    expect(f.store.observe).toHaveBeenCalledWith(ID,OWNER,expect.objectContaining({errorCode:"VERIFICATION_UNAVAILABLE"}));
  });
  test("wrong object metadata is never accepted",async()=>{
    const f=fixture();f.providers.inspect.mockResolvedValue({size:11,contentType:"video/mp4"});await expect(f.runtime.complete(ID,OWNER,"uploaded")).rejects.toMatchObject({status:409});
  });
  test("a previously mismatched object stays rejected",async()=>{
    const f=fixture();f.store.observe.mockResolvedValue({...f.attempt,state:"object_mismatch"});await expect(f.runtime.complete(ID,OWNER,"uploaded")).rejects.toMatchObject({status:409});
  });
  test("observation never implies quiescence and unknown issuance stays explicit",async()=>{
    const f=fixture();const result=await f.runtime.complete(ID,OWNER,"uploaded");
    expect(result.upload.objectObserved).toBe(true);expect(result.upload.providerWriteQuiescenceProven).toBe(false);
    expect(unresolvedUploadReasons({...f.attempt,state:"object_observed",observedObject:{size:10,contentType:"video/mp4",etag:null,version:null}})).toContain("issuance_not_confirmed");
  });
});
