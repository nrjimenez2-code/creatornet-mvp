"use client";
import { useEffect, useRef, useState } from "react";
import type { ProductDelivery } from "@/lib/productDelivery";
import { startPrivateUpload } from "@/lib/privateUploadClient";
import PrivateVideoPlayer from "@/components/PrivateVideoPlayer";
type Asset={id:string;name:string;status:string;duration_seconds:number|null};
export default function ProductDeliveryEditor({type,value,onChange,onBusy}:{type:string;value:ProductDelivery;onChange:(v:ProductDelivery)=>void;onBusy?:(busy:boolean)=>void}){
 const [assets,setAssets]=useState<Asset[]>([]),[uploading,setUploading]=useState(false),[pct,setPct]=useState(0),[error,setError]=useState("");
 const [preview,setPreview]=useState<string|null>(null);
 const upload=useRef<AbortController|null>(null),mounted=useRef(true);
 const latest=useRef({value,onChange,onBusy});
 useEffect(()=>{latest.current={value,onChange,onBusy};},[value,onChange,onBusy]);
 useEffect(()=>{
  mounted.current=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{
   try{
    const response=await fetch("/api/private-videos",{cache:"no-store",credentials:"include"});
    const result=await response.json();if(!response.ok) throw Error(result.error);
    if(mounted.current) setAssets(result.items??[]);
    const pending:Asset[]=(result.items??[]).filter((a:Asset)=>["creating","uploading","processing"].includes(a.status));
    await Promise.all(pending.slice(0,10).map(a=>fetch("/api/private-videos/"+a.id,{cache:"no-store",credentials:"include",signal:AbortSignal.timeout(15000)})));
   }catch{ /* An explicit file action supplies the recoverable error. */ }
   if(mounted.current) timer=setTimeout(load,5000);
  };
  void load();
  return()=>{mounted.current=false;if(timer)clearTimeout(timer);upload.current?.abort();latest.current.onBusy?.(false);};
 },[]);
 const move=<T,>(list:T[],index:number,delta:number)=>{const next=[...list];[next[index],next[index+delta]]=[next[index+delta],next[index]];return next;};
 const fields="rounded-lg border border-white/20 bg-black/40 px-2 py-2 text-sm min-w-0";
 const saveBusy=(busy:boolean)=>{setUploading(busy);onBusy?.(busy);};
 async function choose(file:File){
  upload.current?.abort();const controller=new AbortController();upload.current=controller;saveBusy(true);setError("");setPct(0);
  try{
   await startPrivateUpload(file,controller.signal,setPct,id=>{
    const current=latest.current;
    if(mounted.current && !current.value.videos.some(v=>v.asset_id===id)) current.onChange({...current.value,videos:[...current.value.videos,{asset_id:id,label:file.name.replace(/\.[^.]+$/,"")}]});
   });
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"Upload failed.");}
  finally{if(mounted.current)saveBusy(false);}
 }
 const videoOnly=type==="video" || type==="bundle";
 return <details className="rounded-xl border border-white/10 p-3" open={value.links.length+value.videos.length>0 || undefined}>
  <summary className="cursor-pointer text-sm text-white/80">Product delivery</summary>
  <div className="mt-3 space-y-2">
   {!videoOnly && value.links.map((link,index)=><div key={index} className="flex flex-wrap gap-2">
    <input aria-label={"Link "+(index+1)+" label"} placeholder="Link label" value={link.label} className={fields+" w-28"} onChange={e=>onChange({...value,links:value.links.map((l,i)=>i===index?{...l,label:e.target.value}:l)})}/>
    <input aria-label={"Link "+(index+1)+" URL"} placeholder="https://…" value={link.url} className={fields+" flex-1"} onChange={e=>onChange({...value,links:value.links.map((l,i)=>i===index?{...l,url:e.target.value}:l)})}/>
    <button type="button" aria-label={"Move link "+(index+1)+" up"} disabled={index===0} onClick={()=>onChange({...value,links:move(value.links,index,-1)})}>↑</button>
    <button type="button" aria-label={"Move link "+(index+1)+" down"} disabled={index===value.links.length-1} onClick={()=>onChange({...value,links:move(value.links,index,1)})}>↓</button>
    <button type="button" aria-label={"Remove link "+(index+1)} onClick={()=>onChange({...value,links:value.links.filter((_,i)=>i!==index)})}>×</button>
   </div>)}
   {!videoOnly && <button type="button" className="text-xs text-white/70" onClick={()=>onChange({...value,links:[...value.links,{label:"",url:""}]})}>+ Add link</button>}
   {value.videos.map((video,index)=>{
    const asset=assets.find(a=>a.id===video.asset_id);
    return <div key={video.asset_id} className="rounded-lg border border-white/10 p-2">
     <div className="flex gap-2">
      <input aria-label={"Video "+(index+1)+" title"} value={video.label} className={fields+" flex-1"} onChange={e=>onChange({...value,videos:value.videos.map((v,i)=>i===index?{...v,label:e.target.value}:v)})}/>
      <button type="button" aria-label={"Move video "+(index+1)+" up"} disabled={index===0} onClick={()=>onChange({...value,videos:move(value.videos,index,-1)})}>↑</button>
      <button type="button" aria-label={"Move video "+(index+1)+" down"} disabled={index===value.videos.length-1} onClick={()=>onChange({...value,videos:move(value.videos,index,1)})}>↓</button>
      <button type="button" aria-label={"Remove video "+(index+1)} onClick={()=>onChange({...value,videos:value.videos.filter((_,i)=>i!==index)})}>×</button>
     </div>
     <p className="mt-1 text-xs text-white/60" role="status">{asset?.status==="ready"?"Ready":asset?.status==="failed"?"Processing failed":asset?.status==="canceled"?"Canceled":asset?.status==="uploading"?"Uploading; reselect the same file to resume":asset?.status==="creating"?"Upload creation needs recovery":"Processing"}</p>
     {asset?.status==="ready" && <button type="button" className="text-xs underline" onClick={()=>setPreview(preview===asset.id?null:asset.id)}>{preview===asset.id?"Close preview":"Preview private video"}</button>}
     {preview===asset?.id && <PrivateVideoPlayer assetId={video.asset_id}/>}
     {asset && ["uploading","processing","failed","canceling"].includes(asset.status) && <button type="button" className="text-xs" onClick={async()=>{
      const result=await fetch("/api/private-videos/"+asset.id,{method:"DELETE",credentials:"include"});if(!result.ok)setError("Cancellation needs recovery.");else setAssets(prev=>prev.map(a=>a.id===asset.id?{...a,status:"canceled"}:a));
     }}>{asset.status==="canceling"?"Retry cancellation":"Cancel upload"}</button>}
    </div>;
   })}
   {(type!=="video" || !value.videos.length || value.videos.some(v=>assets.find(a=>a.id===v.asset_id)?.status!=="ready")) && <div className="space-y-2">
    <label className="block cursor-pointer text-xs text-white/70">{type==="video" && value.videos.length ? "Resume: reselect the same file" : "+ Add video"}
     <input type="file" accept="video/*" aria-label="Add private video" disabled={uploading} className="block mt-1 max-w-full text-xs" onChange={e=>{const file=e.target.files?.[0];if(file)void choose(file);e.target.value="";}}/>
    </label>
    {(type!=="video" || !value.videos.length) && <select aria-label="Reuse private video" value="" className={fields+" w-full"} onChange={e=>{
     const a=assets.find(a=>a.id===e.target.value);if(a)onChange({...value,videos:[...value.videos,{asset_id:a.id,label:a.name}]});
    }}><option value="">Reuse an uploaded video…</option>{assets.filter(a=>a.status==="ready" && !value.videos.some(v=>v.asset_id===a.id)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>}
   </div>}
   {uploading && <div className="text-xs" role="status">Uploading {pct}% <button type="button" onClick={()=>upload.current?.abort()}>Pause</button></div>}
   {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
   <p className="text-xs text-white/50">Private videos up to 10 hours and below 30 GB. Reselect the same file to resume an interrupted upload. Every included video must finish processing before publishing.</p>
  </div>
 </details>;
}
