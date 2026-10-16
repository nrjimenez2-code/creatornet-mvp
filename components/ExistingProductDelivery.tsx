"use client";
import { useEffect, useRef, useState } from "react";
import ProductDeliveryEditor from "@/components/ProductDeliveryEditor";
import { readProductDelivery, type ProductDelivery } from "@/lib/productDelivery";
export default function ExistingProductDelivery({productId,type,onBusy}:{productId:string;type:string;onBusy:(busy:boolean)=>void}){
 const [delivery,setDelivery]=useState<ProductDelivery|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[uploading,setUploading]=useState(false),[saving,setSaving]=useState(false);
 const busyRef=useRef(onBusy);
 useEffect(()=>{busyRef.current=onBusy;},[onBusy]);
 useEffect(()=>{
  const controller=new AbortController();
  void fetch("/api/products/"+productId+"/delivery",{credentials:"include",cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(async response=>{
   const result=await response.json();if(controller.signal.aborted)return;
   if(!response.ok)throw Error(result.error||"Delivery unavailable.");
   setDelivery(result.delivery);
  }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"Delivery unavailable.");});
  return()=>{controller.abort();busyRef.current(false);};
 },[productId]);
 async function save(){
  if(!delivery)return;
  setError("");setMessage("");setSaving(true);onBusy(true);
  try{
   const validated=readProductDelivery(delivery,type);
   const response=await fetch("/api/products/"+productId+"/delivery",{method:"PUT",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(validated),signal:AbortSignal.timeout(20000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||"Delivery could not be saved.");
   setMessage("Delivery saved on this product. Existing purchases keep their included content.");
  }catch(e){setError(e instanceof Error?e.message:"Delivery could not be saved.");}
  finally{setSaving(false);onBusy(false);}
 }
 return <div className="space-y-2">
  {delivery && <><ProductDeliveryEditor type={type} value={delivery} onChange={value=>{setDelivery(value);setMessage("");}} onBusy={value=>{setUploading(value);onBusy(value);}}/>
   <button type="button" onClick={()=>void save()} disabled={uploading || saving} className="rounded-lg border border-white/20 px-3 py-2 text-xs disabled:opacity-60">Save product delivery</button></>}
  {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  {message && <p role="status" className="text-xs text-white/60">{message}</p>}
 </div>;
}
