"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { EntitledDelivery } from "@/lib/privateDeliveryServer";
export default function PurchasedProductDelivery({purchaseId}:{purchaseId:string}){
 const [delivery,setDelivery]=useState<EntitledDelivery|null>(null),[error,setError]=useState("");
 useEffect(()=>{
  let canceled=false;const controller=new AbortController();
  void fetch("/api/purchases/"+purchaseId+"/delivery",{credentials:"include",cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(async r=>{
   const data=await r.json();if(!canceled){if(r.ok)setDelivery(data.delivery);else setError(data.error||"Delivery unavailable.");}
  }).catch(()=>{if(!canceled)setError("Delivery unavailable.");});
  return()=>{canceled=true;controller.abort();};
 },[purchaseId]);
 if(error) return <p role="alert" className="text-xs text-white/60">{error}</p>;
 if(!delivery) return <p className="text-xs text-white/50">Loading purchased content…</p>;
 return <div className="mt-3 space-y-2">
  <h2 className="text-sm font-medium">{delivery.title}</h2>
  {delivery.links.map((link,index)=><a key={index} href={link.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-white/20 px-3 py-2 text-sm">{link.label}</a>)}
  {delivery.videos.length>0 && <details open={delivery.videos.length===1}>
   <summary className="cursor-pointer text-sm">Included videos ({delivery.videos.length})</summary>
   <div className="mt-2 space-y-2">{delivery.videos.map(video=>{
    const progress=video.duration_seconds?Math.min(100,Math.round(video.seconds/video.duration_seconds*100)):0;
    return <div key={video.asset_id} className="rounded-lg border border-white/10 p-2">
     <Link href={"/library/"+purchaseId+"/"+video.asset_id} className="block text-sm text-white">{video.label} · {video.seconds>0?"Resume":"Watch"}</Link>
     <progress aria-label={video.label+" progress"} value={progress} max={100} className="mt-1 h-1 w-full"/>
    </div>;
   })}</div>
  </details>}
 </div>;
}
