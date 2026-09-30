"use client";
import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
type Playback={url:string;expires_at:string};
export default function PrivateVideoPlayer({assetId,purchaseId,position=0}:{assetId:string;purchaseId?:string;position?:number}){
 const videoRef=useRef<HTMLVideoElement>(null);
 const [error,setError]=useState(""),[downloadStatus,setDownloadStatus]=useState(""),[downloadBusy,setDownloadBusy]=useState(false);
 useEffect(()=>{
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined,hls:Hls|undefined,refreshing=false,restoring=true,initialized=false;
  let restoreListener:(()=>void)|undefined,current=position,playing=false,rate=1;
  const video=videoRef.current;if(!video)return;
  const controller=new AbortController();
  const remember=()=>{if(!restoring){current=video.currentTime;playing=!video.paused;rate=video.playbackRate;}};
  for(const name of ["timeupdate","play","pause","ratechange"]) video.addEventListener(name,remember);
  const refresh=async()=>{
   if(disposed || refreshing)return;
   refreshing=true;clearTimeout(timer);
   try{
    const response=await fetch("/api/private-videos/"+assetId+"/playback"+(purchaseId?"?purchase_id="+purchaseId:""),{credentials:"include",cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    const access=await response.json() as Playback&{error?:string};
    if(!response.ok){
     if(response.status===401 || response.status===403){
      if(initialized)remember();restoring=true;
      hls?.destroy();hls=undefined;video.pause();video.removeAttribute("src");video.load();
     }
     throw Error(access.error||"No current purchased access.");
    }
    if(disposed)return;
    const remaining=Date.parse(access.expires_at)-Date.now();
    if(!Number.isFinite(remaining) || remaining<=0)throw Error("Playback access has expired.");
    if(initialized)remember();restoring=true;
    if(restoreListener)video.removeEventListener("loadedmetadata",restoreListener);
    restoreListener=()=>{
     video.currentTime=Number.isFinite(video.duration)?Math.min(current,video.duration):current;
     video.playbackRate=rate;restoring=false;initialized=true;
     if(playing)void video.play().catch(()=>{playing=false;});
    };
    video.addEventListener("loadedmetadata",restoreListener,{once:true});
    if(access.url.includes("/manifest/video.m3u8") && !video.canPlayType("application/vnd.apple.mpegurl")){
     const {default:HlsClient}=await import("hls.js");
     if(disposed)return;
     if(!HlsClient.isSupported())throw Error("This browser cannot play this video.");
     if(!hls){hls=new HlsClient();hls.attachMedia(video);hls.on(HlsClient.Events.ERROR,(_event,data)=>{if(data.fatal)void refresh();});}
     hls.loadSource(access.url);
    }else video.src=access.url;
    setError("");
    timer=setTimeout(()=>void refresh(),Math.max(1000,remaining-Math.min(60000,remaining/2)));
   }catch(e){
    if(!disposed){if(initialized)remember();restoring=true;video.pause();hls?.stopLoad();setError(e instanceof Error?e.message:"Playback unavailable.");timer=setTimeout(()=>void refresh(),15000);}
   }finally{refreshing=false;}
  };
  const visible=()=>{if(document.visibilityState==="visible")void refresh();};
  document.addEventListener("visibilitychange",visible);void refresh();
  return()=>{
   disposed=true;controller.abort();clearTimeout(timer);document.removeEventListener("visibilitychange",visible);
   for(const name of ["timeupdate","play","pause","ratechange"])video.removeEventListener(name,remember);
   if(restoreListener)video.removeEventListener("loadedmetadata",restoreListener);
   hls?.destroy();video.pause();video.removeAttribute("src");video.load();
  };
 },[assetId,purchaseId,position]);
 useEffect(()=>{
  const video=videoRef.current;if(!video)return;
  if(!purchaseId)return;
  let lastSaved=-1;
  const save=()=>{
   const seconds=video.currentTime;if(video.readyState<1 || !Number.isFinite(seconds) || Math.abs(seconds-lastSaved)<1)return;lastSaved=seconds;
   void fetch("/api/private-videos/"+assetId+"/progress",{method:"PUT",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({purchase_id:purchaseId,seconds}),keepalive:true}).catch(()=>{});
  };
  const timer=setInterval(save,10000);video.addEventListener("pause",save);video.addEventListener("ended",save);
  return()=>{clearInterval(timer);save();video.removeEventListener("pause",save);video.removeEventListener("ended",save);};
 },[assetId,purchaseId]);
 async function download(){
  setDownloadBusy(true);
  try{
   const response=await fetch("/api/private-videos/"+assetId+"/download?purchase_id="+purchaseId,{method:downloadStatus==="processing"?"GET":"POST",credentials:"include",cache:"no-store",signal:AbortSignal.timeout(20000)});
   const result=await response.json();
   if(!response.ok)throw Error(result.error||"Download unavailable.");
   if(result.status==="ready" && result.download_url){setDownloadStatus("");window.location.assign(result.download_url);}
   else setDownloadStatus(result.status==="failed"?"failed":"processing");
  }catch(e){setError(e instanceof Error?e.message:"Download unavailable.");}
  finally{setDownloadBusy(false);}
 }
 return <div>
  <video ref={videoRef} controls playsInline preload="metadata" className="aspect-video w-full rounded-xl bg-black"/>
  {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
  {purchaseId && <button type="button" onClick={()=>void download()} disabled={downloadBusy} className="mt-3 text-sm underline disabled:opacity-60">
   {downloadBusy?"Preparing download…":downloadStatus==="processing"?"Check MP4 download":downloadStatus==="failed"?"Retry MP4 download":"Download purchased video"}
  </button>}
  {downloadStatus==="processing" && <p role="status" className="mt-2 text-xs text-white/60">The MP4 is processing. Check again shortly.</p>}
 </div>;
}
