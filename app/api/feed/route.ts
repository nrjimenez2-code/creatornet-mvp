import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { withDiscoverDatabaseTiming, discoverDatabaseTimingHeader } from '@/lib/discoverDatabaseTiming';
import { discoverEnabled, discoverIdentity, setDiscoverCookie, createDiscoverSession, createDiscoverSessionWithFirstPage, readDiscoverPage } from "@/lib/discoverServer";
import { DISCOVER_SESSION_UNAVAILABLE, DiscoverSessionUnavailableError } from "@/lib/discoverFeedError";
import { createDiscoverRouteTiming } from '@/lib/discoverRouteTiming';
import { createDiscoverTimingLogger, discoverTimingEnabled } from '@/lib/discoverTimingLog';
const routeTiming = createDiscoverRouteTiming();
const logTiming = createDiscoverTimingLogger('feed');
export async function GET(req:NextRequest){
 const lifecycle = routeTiming();
 return withDiscoverDatabaseTiming(() => feedResponse(req,lifecycle));
}
async function feedResponse(req:NextRequest,lifecycle:string[]){
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
  if (!discoverTimingEnabled()) return response;
  const metrics = [...timings,...discoverDatabaseTimingHeader(),...lifecycle,`total;dur=${(performance.now()-started).toFixed(1)}`];
  // Preview contains numeric timing and invocation diagnostics only, never actor/session identifiers.
  if(process.env.VERCEL_ENV==='preview') response.headers.set('Server-Timing',metrics.join(', '));
  else logTiming(response.status,metrics);
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
  if (!req.nextUrl.searchParams.has('session') && process.env.DISCOVER_CREATE_PAGE_ENABLED === 'true') {
   const created=await measured('session',()=>createDiscoverSessionWithFirstPage(identity.actor,identity.userId,tab,identity.newAnonymous,offset,limit,
    discoverTimingEnabled() ? (name,duration)=>{timings.push(`${name};dur=${duration.toFixed(1)}`);} : undefined));
   return finish(setDiscoverCookie(NextResponse.json({...created.result,session:created.session,actorToken:identity.token}),identity.cookie));
  }
  const session=req.nextUrl.searchParams.get('session')??await measured('session',()=>createDiscoverSession(identity.actor,identity.userId,tab,identity.newAnonymous,discoverTimingEnabled() ? (name, duration) => { timings.push(`${name};dur=${duration.toFixed(1)}`); } : undefined));
  const result=await measured('page',()=>readDiscoverPage(session,identity.actor,offset,limit,identity.userId));
  return finish(setDiscoverCookie(NextResponse.json({...result,session,actorToken:identity.token}),identity.cookie));
 }catch(error){
  if(error instanceof DiscoverSessionUnavailableError)
   return finish(NextResponse.json({error:'This feed needs to be refreshed.',code:DISCOVER_SESSION_UNAVAILABLE},{status:410,headers:{'Cache-Control':'private, no-store'}}));
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  // SQLSTATE/PostgREST codes are enough to diagnose failures without logging
  // database messages, query details, credentials or actor identifiers.
  console.error('[discover] feed unavailable', {phase,
   code: typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code) ? code : 'UNKNOWN'});
  return finish(NextResponse.json({error:'Could not load this feed. Refresh to try again.'},{status:503}));}
}
