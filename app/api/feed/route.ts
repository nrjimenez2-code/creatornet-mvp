import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { withDiscoverDatabaseTiming, discoverDatabaseTimingHeader } from '@/lib/discoverDatabaseTiming';
import { discoverEnabled, discoverIdentity, setDiscoverCookie, createDiscoverSession, readDiscoverPage } from "@/lib/discoverServer";
export async function GET(req:NextRequest){
 return withDiscoverDatabaseTiming(() => feedResponse(req));
}
async function feedResponse(req:NextRequest){
 const timings: string[] = [];
 const started = performance.now();
 let phase = 'legacy';
 const measured = async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
  phase = name;
  const start = performance.now();
  try { return await work(); }
  finally { timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`); }
 };
 const finish = (response: NextResponse) => {
  // Preview diagnostics contain durations only, never actor/session identifiers.
  if(process.env.VERCEL_ENV==='preview') response.headers.set('Server-Timing',
   [...timings,...discoverDatabaseTimingHeader(),`total;dur=${(performance.now()-started).toFixed(1)}`].join(', '));
  return response;
 };
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
  const identity=await measured('identity',()=>discoverIdentity(req));
  const session=req.nextUrl.searchParams.get('session')??await measured('session',()=>createDiscoverSession(identity.actor,identity.userId,tab));
  const result=await measured('page',()=>readDiscoverPage(session,identity.actor,offset,limit,identity.userId));
  return finish(setDiscoverCookie(NextResponse.json({...result,session,actorToken:identity.token}),identity.cookie));
 }catch(error){
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  // SQLSTATE/PostgREST codes are enough to diagnose failures without logging
  // database messages, query details, credentials or actor identifiers.
  console.error('[discover] feed unavailable', {phase,
   code: typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code) ? code : 'UNKNOWN'});
  return finish(NextResponse.json({error:'Could not load this feed. Refresh to try again.'},{status:503}));}
}
