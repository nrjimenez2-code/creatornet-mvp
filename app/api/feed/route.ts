import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { discoverEnabled, discoverIdentity, setDiscoverCookie, createDiscoverSession, readDiscoverPage } from "@/lib/discoverServer";
export async function GET(req:NextRequest){
 const tab=req.nextUrl.searchParams.get('tab')==='following'?'following':'discover';
 const offset=Number(req.nextUrl.searchParams.get('offset')??0),limit=Number(req.nextUrl.searchParams.get('limit')??20);
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)return NextResponse.json({error:'Invalid page'},{status:400});
 try{
  if(!discoverEnabled()){
   if(offset>=2000)return NextResponse.json({items:[],nextOffset:offset,hasMore:false,session:null});
   const {data,error}=await createServerClient().rpc('get_feed_v3',{p_tab:tab,p_limit:Math.min(limit,2000-offset),p_offset:offset});
   if(error)throw error;
   return NextResponse.json({items:data??[],nextOffset:offset+(data?.length??0),hasMore:(data?.length??0)>=limit&&offset+limit<2000,session:null},{headers:{'Cache-Control':'private, no-store'}});
  }
  const identity=await discoverIdentity(req);
  const session=req.nextUrl.searchParams.get('session')??await createDiscoverSession(identity.actor,identity.userId,tab);
  const result=await readDiscoverPage(session,identity.actor,offset,limit,identity.userId);
  return setDiscoverCookie(NextResponse.json({...result,session,actorToken:identity.token}),identity.cookie);
 }catch(error){console.error('[discover] feed unavailable',error instanceof Error?error.message:'database error');
  return NextResponse.json({error:'Could not load this feed. Refresh to try again.'},{status:503});}
}
