import { PREMIUM_MAX_BYTES, PREMIUM_MAX_SECONDS } from "@/lib/productDelivery";
export const PREMIUM_TUS_CHUNK=8*1024*1024;
export type UploadSession={asset_id:string;status:string;upload_url?:string;expires_at?:string;error?:string};
export async function privateFileFingerprint(file:File):Promise<string>{
 const sample=1024*1024, middle=Math.max(0,Math.floor(file.size/2)-sample/2);
 const bytes=await new Blob([JSON.stringify({name:file.name,size:file.size,modified:file.lastModified}),
  file.slice(0,sample),file.slice(middle,middle+sample),file.slice(Math.max(0,file.size-sample))]).arrayBuffer();
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
}
export function privateFileDuration(file:File):Promise<number>{
 return new Promise((resolve,reject)=>{
  const video=document.createElement("video"),url=URL.createObjectURL(file);
  const finish=(duration?:number)=>{clearTimeout(timeout);video.removeAttribute("src");video.load();URL.revokeObjectURL(url);
   if(duration && Number.isFinite(duration) && duration<=PREMIUM_MAX_SECONDS) resolve(duration);else reject(Error("Could not detect a video duration below 10 hours."));};
  const timeout=setTimeout(()=>finish(),20000);
  video.preload="metadata";video.onloadedmetadata=()=>finish(video.duration);video.onerror=()=>finish();video.src=url;
 });
}
function abortError(){return new DOMException("Upload paused.","AbortError");}
async function pause(ms:number,signal:AbortSignal){
 if(signal.aborted) throw abortError();
 await new Promise<void>((resolve,reject)=>{
  const stopped=()=>{clearTimeout(timer);signal.removeEventListener("abort",stopped);reject(abortError());};
  const timer=setTimeout(()=>{signal.removeEventListener("abort",stopped);resolve();},ms);
  signal.addEventListener("abort",stopped,{once:true});
 });
}
/** HEAD recovers the provider's committed offset after every lost reply. No
 * complete file is buffered, and a PATCH always uses that exact offset. */
export async function uploadTusFile(file:File,url:string,signal:AbortSignal,onProgress:(value:number)=>void){
 let failures=0;
 while(true){
  if(signal.aborted) throw abortError();
  try{
   const head=await fetch(url,{method:"HEAD",headers:{"Tus-Resumable":"1.0.0"},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),credentials:"omit",cache:"no-store"});
   if(head.status===404 || head.status===410) throw Error("Upload link expired. Choose Retry to start a new upload.");
   if(!head.ok) throw Error("Upload connection interrupted.");
   const rawOffset=head.headers.get("Upload-Offset"),rawLength=head.headers.get("Upload-Length");
   if(rawOffset===null || !/^\d+$/.test(rawOffset)) throw Error("Invalid upload offset.");
   const offset=Number(rawOffset);
   if(!Number.isSafeInteger(offset) || offset<0 || offset>file.size || rawLength!==null && Number(rawLength)!==file.size) throw Error("Reselect the original file to resume.");
   onProgress(Math.round(offset/file.size*100));
   if(offset===file.size) return;
   const end=Math.min(file.size,offset+PREMIUM_TUS_CHUNK);
   const response=await fetch(url,{method:"PATCH",headers:{"Tus-Resumable":"1.0.0","Upload-Offset":String(offset),"Content-Type":"application/offset+octet-stream"},
    body:file.slice(offset,end),signal:AbortSignal.any([signal,AbortSignal.timeout(300000)]),credentials:"omit"});
   if(response.status===409){if(++failures>5) throw Error("Another upload is writing this file.");continue;}
   if(!response.ok) throw Error("Upload connection interrupted.");
   const committed=Number(response.headers.get("Upload-Offset"));
   if(committed!==end) throw Error("Upload needs offset recovery.");
   onProgress(Math.round(end/file.size*100));failures=0;
   if(end===file.size) return;
  }catch(e){
   if(signal.aborted) throw abortError();
   if(e instanceof Error && /expired|original file|Invalid upload/.test(e.message)) throw e;
   if(++failures>5) throw Error("Upload interrupted. Reselect the same file to resume.");
   await pause(Math.min(5000,500*2**(failures-1)),signal);
  }
 }
}
export async function startPrivateUpload(file:File,signal:AbortSignal,onProgress:(value:number)=>void,onCreated?:(id:string)=>void):Promise<string>{
 if(file.size<=0 || file.size>=PREMIUM_MAX_BYTES) throw Error("Video must be below 30 GB.");
 const [duration,fingerprint]=await Promise.all([privateFileDuration(file),privateFileFingerprint(file)]);
 if(signal.aborted) throw abortError();
 const response=await fetch("/api/private-videos",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),
  body:JSON.stringify({name:file.name,size:file.size,duration,fingerprint})});
 const session=await response.json() as UploadSession;
 if(!response.ok) throw Error(session.error||"Upload could not start.");
 onCreated?.(session.asset_id);
 if(session.status==="ready" || session.status==="processing"){onProgress(100);return session.asset_id;}
 if(!session.upload_url) throw Error(session.error||"Upload creation is pending recovery. Retry to check the same upload.");
 await uploadTusFile(file,session.upload_url,signal,onProgress);
 return session.asset_id;
}
