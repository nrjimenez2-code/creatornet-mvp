"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import PrivateVideoPlayer from "@/components/PrivateVideoPlayer";
import type { EntitledDelivery } from "@/lib/privateDeliveryServer";
export default function PurchasedVideoPage({params}:{params:Promise<{purchaseId:string;assetId:string}>}){
 const {purchaseId,assetId}=use(params),[delivery,setDelivery]=useState<EntitledDelivery|null>(null),[error,setError]=useState("");
 useEffect(()=>{
  let disposed=false;const controller=new AbortController();
  void fetch("/api/purchases/"+purchaseId+"/delivery",{credentials:"include",cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(async r=>{
   const data=await r.json();if(disposed)return;if(r.ok)setDelivery(data.delivery);else setError(data.error||"No current access.");
  }).catch(()=>{if(!disposed)setError("Purchased video unavailable.");});
  return()=>{disposed=true;controller.abort();};
 },[purchaseId]);
 const video=delivery?.videos.find(v=>v.asset_id===assetId);
 return <main className="mx-auto max-w-5xl p-5 text-white"><Link href="/library" className="text-sm text-white/60">← Library</Link>
  {video?<><h1 className="my-4 text-xl font-semibold">{video.label}</h1><PrivateVideoPlayer assetId={assetId} purchaseId={purchaseId} position={video.seconds}/></>:<p role="status" className="mt-5">{error || (delivery?"This video is not part of the purchased product.":"Loading…")}</p>}
 </main>;
}
