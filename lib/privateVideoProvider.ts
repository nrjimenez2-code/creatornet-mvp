import "server-only";
import { createPrivateKey, sign } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { reservedVideoSeconds, PREMIUM_MAX_SECONDS } from "@/lib/productDelivery";

export type PrivateAsset = { id: string; creator_id: string; provider: "stream" | "supabase"; provider_id: string | null; status: string; duration_seconds: number | null };
export type VideoStatus = { status: "uploading" | "processing" | "ready" | "failed"; duration: number | null; failure: string | null };
const UID=/^[a-f0-9]{32}$/;
const config=()=>{
 const account=process.env.PREMIUM_STREAM_ACCOUNT_ID, token=process.env.PREMIUM_STREAM_API_TOKEN;
 if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw Error("Private video uploads are not configured.");
 return {endpoint:`https://api.cloudflare.com/client/v4/accounts/${account}/stream`,token};
};
const b64=(value:string)=>Buffer.from(value).toString("base64");
export class PrivateUploadRejected extends Error {}
export class PrivateVideoGone extends Error {}
export function validTusUploadUrl(value: string): boolean {
 try {const u=new URL(value); return u.protocol==="https:" && !u.username && !u.password &&
  (u.hostname==="upload.videodelivery.net" || u.hostname==="upload.cloudflarestream.com" || /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(u.hostname));}
 catch {return false;}
}
/** Creation is intentionally not retried: an unknown result retains its asset identity. */
export async function createPrivateStreamUpload(input:{assetId:string;creatorId:string;size:number;duration:number;expiresAt:string}){
 const {endpoint,token}=config();
 const metadata=[
  `name ${b64("creatornet-premium-"+input.assetId)}`,
  `maxDurationSeconds ${b64(String(reservedVideoSeconds(input.duration)))}`,
  "requiresignedurls",
  `expiry ${b64(input.expiresAt)}`,
 ].join(",");
 const response=await fetch(endpoint+"?direct_user=true",{method:"POST",headers:{
  Authorization:"Bearer "+token,"Tus-Resumable":"1.0.0","Upload-Length":String(input.size),
  "Upload-Metadata":metadata,"Upload-Creator":input.creatorId,
 },signal:AbortSignal.timeout(20000),redirect:"error",cache:"no-store"});
 const url=response.headers.get("Location"), uid=response.headers.get("stream-media-id");
 if([400,401,403,413,422,429].includes(response.status) && !uid) throw new PrivateUploadRejected("The private video provider declined this upload.");
 if (!response.ok || !url || !validTusUploadUrl(url) || !uid || !UID.test(uid)) throw Error("Upload creation needs recovery; retrying will not create a replacement.");
 return {uid,url};
}
async function streamRequest(uid:string,method="GET",body?:unknown,suffix=""){
 if (!UID.test(uid)) throw Error("Invalid private video identifier.");
 const {endpoint,token}=config();
 const response=await fetch(endpoint+"/"+uid+suffix,{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
  ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),redirect:"error",cache:"no-store"});
 if (method==="DELETE" && response.status===404) return null;
 if (response.status===404) throw new PrivateVideoGone("The private video no longer exists at the provider.");
 if (!response.ok) throw Error("Private video provider is temporarily unavailable.");
 if (method==="DELETE") return null;
 const result=await response.json();
 if (!result.success || !result.result) throw Error("Private video status is unavailable.");
 return result.result;
}
export async function privateStreamStatus(uid:string):Promise<VideoStatus>{
 const result=await streamRequest(uid);
 if (result.uid!==uid || result.requireSignedURLs!==true) return {status:"failed",duration:null,failure:"private_access_required"};
 const duration=typeof result.duration==="number" && Number.isFinite(result.duration)?result.duration:null;
 if (duration!==null && duration>PREMIUM_MAX_SECONDS) return {status:"failed",duration:null,failure:"duration_exceeded"};
 const state=result.status?.state;
 if (state==="error") return {status:"failed",duration,failure:String(result.status?.errorReasonCode||"processing_failed").slice(0,100)};
 if (result.readyToStream===true && state==="ready" && duration!==null && duration>0) return {status:"ready",duration,failure:null};
 return {status:state==="pendingupload"?"uploading":"processing",duration,failure:null};
}
export const cancelPrivateStreamUpload=(uid:string)=>streamRequest(uid,"DELETE");

/** Locate an uncertain creation by our exact asset identity; never create here. */
export async function recoverPrivateStreamUpload(assetId:string,creatorId:string){
 const {endpoint,token}=config(),name="creatornet-premium-"+assetId;
 const query=new URLSearchParams({video_name:name,creator:creatorId,limit:"2"});
 const response=await fetch(endpoint+"?"+query,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(15000),redirect:"error",cache:"no-store"});
 if(!response.ok) throw Error("Private upload reconciliation unavailable.");
 const payload=await response.json();
 if(!payload.success || !Array.isArray(payload.result)) throw Error("Private upload reconciliation unavailable.");
 const matches=payload.result.filter((v:{meta?:{name?:string};creator?:string;uid?:string})=>v.meta?.name===name && v.creator===creatorId);
 if(!matches.length) return null;
 if(matches.length!==1 || !UID.test(matches[0].uid) || matches[0].requireSignedURLs!==true) throw Error("Private upload reconciliation differs.");
 return {uid:matches[0].uid as string,status:await privateStreamStatus(matches[0].uid)};
}
export async function privateStreamDownload(uid:string,create=false){
 let result=await streamRequest(uid,"GET",undefined,"/downloads");
 if((!result.default || result.default.status==="error") && create) result=await streamRequest(uid,"POST",undefined,"/downloads");
 const current=result.default;
 return {status:current?.status==="ready"?"ready":current?.status==="error"?"failed":current?"processing":"absent",
  percent:typeof current?.percentComplete==="number"?Math.min(100,Math.max(0,current.percentComplete)):0};
}

export function signPrivateStreamPlayback(uid:string,seconds:number,downloadable=false){
 if (!UID.test(uid)) throw Error("Invalid private video identifier.");
 const kid=process.env.PREMIUM_STREAM_SIGNING_KEY_ID, encoded=process.env.PREMIUM_STREAM_SIGNING_JWK;
 const host=process.env.PREMIUM_STREAM_PLAYBACK_HOST;
 if (!kid || !encoded || !host || !/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(host)) throw Error("Private playback is not configured.");
 const now=Math.floor(Date.now()/1000), expires=now+Math.min(900,Math.max(1,Math.floor(seconds)));
 const header=Buffer.from(JSON.stringify({alg:"RS256",kid})).toString("base64url");
 const payload=Buffer.from(JSON.stringify({sub:uid,kid,exp:expires,nbf:now-5,...(downloadable?{downloadable:true}:{})})).toString("base64url");
 const unsigned=header+"."+payload;
 const jwk=JSON.parse(Buffer.from(encoded,"base64").toString("utf8")) as JsonWebKey;
 const signature=sign("RSA-SHA256",Buffer.from(unsigned),createPrivateKey({key:jwk,format:"jwk"})).toString("base64url");
 const token=unsigned+"."+signature, origin="https://"+host;
 return {url:origin+"/"+token+"/manifest/video.m3u8",iframe_url:origin+"/"+token+"/iframe",expires_at:new Date(expires*1000).toISOString(),
  ...(downloadable?{download_url:origin+"/"+token+"/downloads/default.mp4"}:{})};
}
