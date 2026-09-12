import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { processNextSearchVideo } from "@/lib/searchVideoText";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=180;
export async function GET(req:Request) {
  const secret=process.env.CRON_SECRET;
  const hash=(value:string)=>createHash("sha256").update(value).digest();
  if(!secret || secret.length<32 || !timingSafeEqual(hash(req.headers.get("authorization") ?? ""),hash(`Bearer ${secret}`))) return NextResponse.json({error:"Unauthorized"},{status:401});
  try {return NextResponse.json(await processNextSearchVideo(),{headers:{"Cache-Control":"no-store"}});}
  catch {return NextResponse.json({error:"Video search processing needs retry."},{status:503});}
}
