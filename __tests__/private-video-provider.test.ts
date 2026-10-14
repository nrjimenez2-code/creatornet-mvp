import { generateKeyPairSync, verify } from "node:crypto";
import { createPrivateStreamUpload, privateStreamStatus, signPrivateStreamPlayback, privateStreamDownload, recoverPrivateStreamUpload, PrivateVideoGone } from "@/lib/privateVideoProvider";
const env={...process.env},originalFetch=globalThis.fetch;
const uid="a".repeat(32),asset="11111111-1111-4111-8111-111111111111";
beforeEach(()=>{
 process.env.PREMIUM_STREAM_ACCOUNT_ID="b".repeat(32);process.env.PREMIUM_STREAM_API_TOKEN="synthetic-test-only";
 globalThis.fetch=jest.fn();
});
afterEach(()=>{process.env={...env};globalThis.fetch=originalFetch;});
test.each([300,1800,3600,7200,36000])("TUS %s seconds is signed from creation and reserves near detected duration",async duration=>{
 (fetch as jest.Mock).mockResolvedValue(new Response(null,{status:201,headers:{Location:"https://upload.videodelivery.net/tus/synthetic","stream-media-id":uid}}));
 const result=await createPrivateStreamUpload({assetId:asset,creatorId:"creator",size:1_000_000,duration,expiresAt:"2026-10-01T00:00:00Z"});
 expect(result.uid).toBe(uid);
 const [url,request]=(fetch as jest.Mock).mock.calls[0];
 expect(url).toContain("?direct_user=true");expect(request.headers["Upload-Length"]).toBe("1000000");
 const meta=request.headers["Upload-Metadata"].split(",") as string[];
 expect(meta).toContain("requiresignedurls");
 const maximum=Number(Buffer.from(meta.find(v=>v.startsWith("maxDurationSeconds "))!.split(" ")[1],"base64").toString());
 expect(maximum).toBeLessThanOrEqual(36000);expect(maximum).toBeGreaterThanOrEqual(duration);expect(maximum).toBeLessThanOrEqual(duration+Math.max(10,duration*.02)+1);
});
test("uncertain creation is never retried or replaced",async()=>{
 (fetch as jest.Mock).mockRejectedValue(Error("Response lost"));
 await expect(createPrivateStreamUpload({assetId:asset,creatorId:"creator",size:100,duration:300,expiresAt:"2026-10-01T00:00:00Z"})).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([["pendingupload",false,"uploading"],["inprogress",false,"processing"],["ready",true,"ready"],["error",false,"failed"]])("provider state %s maps to %s",async(state,ready,status)=>{
 (fetch as jest.Mock).mockResolvedValue(Response.json({success:true,result:{uid,requireSignedURLs:true,readyToStream:ready,status:{state},duration:3600}}));
 expect((await privateStreamStatus(uid)).status).toBe(status);
});
test("unsigned media and an excessive processed duration never become ready",async()=>{
 (fetch as jest.Mock).mockResolvedValue(Response.json({success:true,result:{uid,requireSignedURLs:false,readyToStream:true,status:{state:"ready"},duration:3600}}));
 expect((await privateStreamStatus(uid)).status).toBe("failed");
 (fetch as jest.Mock).mockResolvedValue(Response.json({success:true,result:{uid,requireSignedURLs:true,readyToStream:true,status:{state:"ready"},duration:36001}}));
 expect((await privateStreamStatus(uid)).failure).toBe("duration_exceeded");
});
test("playback JWT is verified, bounded and only downloads carry downloadable permission",()=>{
 const keys=generateKeyPairSync("rsa",{modulusLength:2048});
 process.env.PREMIUM_STREAM_SIGNING_KEY_ID="synthetic-kid";
 process.env.PREMIUM_STREAM_SIGNING_JWK=Buffer.from(JSON.stringify(keys.privateKey.export({format:"jwk"}))).toString("base64");
 process.env.PREMIUM_STREAM_PLAYBACK_HOST="customer-synthetic.cloudflarestream.com";
 for(const downloadable of [false,true]){
  const result=signPrivateStreamPlayback(uid,7,downloadable);
  const [header,payload,signature]=new URL(result.url).pathname.split("/")[1].split(".");
  expect(verify("RSA-SHA256",Buffer.from(header+"."+payload),keys.publicKey,Buffer.from(signature,"base64url"))).toBe(true);
  const claims=JSON.parse(Buffer.from(payload,"base64url").toString());
  expect(claims.sub).toBe(uid);expect(claims.exp-Math.floor(Date.now()/1000)).toBeLessThanOrEqual(7);
  expect(claims.downloadable).toBe(downloadable?true:undefined);expect(Boolean(result.download_url)).toBe(downloadable);
 }
});
test("downloads are created only on explicit request; never return the raw provider URL",async()=>{
 (fetch as jest.Mock).mockResolvedValueOnce(Response.json({success:true,result:{}})).mockResolvedValueOnce(Response.json({success:true,result:{default:{status:"inprogress",percentComplete:10,url:"https://provider/raw"}}}));
 expect(await privateStreamDownload(uid,true)).toEqual({status:"processing",percent:10});
 expect((fetch as jest.Mock).mock.calls.map(c=>c[1].method)).toEqual(["GET","POST"]);
 (fetch as jest.Mock).mockClear().mockResolvedValue(Response.json({success:true,result:{}}));
 expect((await privateStreamDownload(uid)).status).toBe("absent");expect(fetch).toHaveBeenCalledTimes(1);
});
test("uncertain creation recovery searches the exact creator and asset, without a provider write",async()=>{
 (fetch as jest.Mock).mockResolvedValue(Response.json({success:true,result:[]}));
 expect(await recoverPrivateStreamUpload(asset,"creator")).toBeNull();
 const [url,request]=(fetch as jest.Mock).mock.calls[0];
 expect(new URL(url).searchParams.get("creator")).toBe("creator");
 expect(new URL(url).searchParams.get("video_name")).toBe("creatornet-premium-"+asset);expect(request.method).toBeUndefined();
});
test("a confirmed missing video is distinguished from transient provider errors",async()=>{
 (fetch as jest.Mock).mockResolvedValue(new Response(null,{status:404}));
 await expect(privateStreamStatus(uid)).rejects.toBeInstanceOf(PrivateVideoGone);
 (fetch as jest.Mock).mockResolvedValue(new Response(null,{status:503}));
 await expect(privateStreamStatus(uid)).rejects.not.toBeInstanceOf(PrivateVideoGone);
});
test("explicit retry restarts failed MP4 generation for the same video, while status checks never create it",async()=>{
 (fetch as jest.Mock).mockResolvedValueOnce(Response.json({success:true,result:{default:{status:"error"}}}))
 .mockResolvedValueOnce(Response.json({success:true,result:{default:{status:"inprogress",percentComplete:0}}}));
 expect((await privateStreamDownload(uid,true)).status).toBe("processing");
 expect((fetch as jest.Mock).mock.calls.map(c=>c[1].method)).toEqual(["GET","POST"]);
 expect((fetch as jest.Mock).mock.calls.every(c=>c[0].includes("/"+uid+"/downloads"))).toBe(true);
});
