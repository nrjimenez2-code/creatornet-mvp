/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const actor="a".repeat(64), ip="b".repeat(64), other="c".repeat(64), contract="d".repeat(64);
jest.setTimeout(90000);
beforeEach(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;`);
 await db.exec(readFileSync("supabase/migrations/20261023030607_durable_critical_abuse_admission.sql","utf8"));
});
afterEach(async()=>{await db.close();});
async function admit(action="feed_page",who=actor,address=ip,operation:string|null=null,bytes=0,seconds=0,resource="resource",fingerprint=contract){
 const result=await db.query<{result:{allowed:boolean;reused?:boolean;retry_after?:number;resource?:string}}>(
  "select public.abuse_admit_v1($1,$2,$3,$4,$5,$6,$7,$8) result",
  [action,who,address,operation,operation?fingerprint:null,operation?resource:null,bytes,seconds]);
 return result.rows[0].result;
}
test("clients cannot execute or inspect admission tables; trusted service can",async()=>{
 expect((await db.query("select has_function_privilege('anon','public.abuse_admit_v1(text,text,text,text,text,text,bigint,bigint)','EXECUTE') allowed")).rows).toEqual([{allowed:false}]);
 await db.exec("set role authenticated");await expect(admit()).rejects.toMatchObject({code:"42501"});
 await expect(db.query("select * from abuse_private.buckets")).rejects.toMatchObject({code:"42501"});
 await db.exec("reset role;set role service_role");expect((await admit()).allowed).toBe(true);
});
test("request limits persist across independent calls and a competing burst admits exactly the remaining token",async()=>{
 await admit();await db.exec("update abuse_private.buckets set requests=119 where subject like 'a:%'");
 const results=await Promise.all(Array.from({length:8},()=>admit()));
 expect(results.filter(r=>r.allowed)).toHaveLength(1);
 expect(results.filter(r=>!r.allowed).every(r=>(r.retry_after??0)>0)).toBe(true);
 expect((await admit("feed_page",other)).allowed).toBe(true);
});
test("IP denial charges none of another actor's budgets",async()=>{
 await admit();await db.exec("update abuse_private.buckets set requests=1200 where subject like 'i:%'");
 expect((await admit("feed_page",other)).allowed).toBe(false);
 expect((await db.query("select requests from abuse_private.buckets where subject=$1",['a:'+other])).rows).toEqual([]);
 const before=(await db.query("select count(*)::int n from abuse_private.buckets")).rows;
 for(let n=0;n<30;n++)expect((await admit("feed_page",n.toString(16).padStart(64,"0"))).allowed).toBe(false);
 expect((await db.query("select count(*)::int n from abuse_private.buckets")).rows).toEqual(before);
});
test("feed session minute and hour budgets are checked together",async()=>{
 await admit("feed_session");await db.exec("update abuse_private.buckets set requests=60 where window_seconds=3600");
 expect((await admit("feed_session")).allowed).toBe(false);
 expect((await db.query("select requests from abuse_private.buckets where window_seconds=60 and subject like 'a:%'")).rows).toEqual([{requests:1}]);
});
test("random upload IDs cannot bypass daily bytes; retry recovers identity without reserving daily bytes again",async()=>{
 const operation="1".repeat(64);
 expect(await admit("public_upload",actor,ip,operation,500*1024*1024,0,"videos/owned/launch_id.mp4")).toMatchObject({allowed:true,reused:false});
 await db.exec("update abuse_private.buckets set bytes=21474836480 where window_seconds=86400");
 expect(await admit("public_upload",actor,ip,operation,500*1024*1024,0,"different-resource")).toMatchObject({allowed:true,reused:true,resource:"videos/owned/launch_id.mp4"});
 expect((await admit("public_upload",actor,ip,"2".repeat(64),1)).allowed).toBe(false);
 await expect(admit("public_upload",actor,ip,operation,500*1024*1024,0,"resource","e".repeat(64))).rejects.toThrow("Upload contract changed");
 expect((await db.query("select requests from abuse_private.buckets where window_seconds=86400")).rows).toEqual([{requests:1}]);
});
test("upload retries still spend request budget and concurrent operation IDs share one daily reservation",async()=>{
 const op="3".repeat(64);
 const replies=await Promise.all(Array.from({length:8},(_,n)=>admit("public_upload",actor,ip,op,100,0,"resource-"+n)));
 expect(replies.filter(r=>!r.reused)).toHaveLength(1);
 expect(new Set(replies.map(r=>r.resource)).size).toBe(1);
 expect((await db.query("select requests from abuse_private.buckets where window_seconds=86400")).rows).toEqual([{requests:1}]);
 await db.exec("update abuse_private.buckets set requests=30 where window_seconds=60 and subject like 'a:%'");
 expect((await admit("public_upload",actor,ip,op,100)).allowed).toBe(false);
});
test("private maximum remains admissible and duration and count limits refuse atomically",async()=>{
 expect((await admit("premium_upload",actor,ip,"4".repeat(64),29999999999,36000)).allowed).toBe(true);
 await db.exec("update abuse_private.buckets set seconds=144000 where window_seconds=86400");
 expect((await admit("premium_upload",actor,ip,"5".repeat(64),1,1)).allowed).toBe(false);
 expect((await db.query("select requests from abuse_private.buckets where window_seconds=60 and subject like 'a:%'")).rows).toEqual([{requests:1}]);
});
test("invalid/unknown actions and quantities cannot create counters",async()=>{
 for(const input of [["unknown",0,0],["feed_page",1,0],["public_upload",-1,0],["premium_upload",30000000000,1],["premium_upload",1,36001]] as const){
  await expect(admit(input[0],actor,ip,input[0].includes('upload')?"6".repeat(64):null,input[1],input[2])).rejects.toThrow();
 }
 expect((await db.query("select count(*)::int count from abuse_private.buckets")).rows).toEqual([{count:0}]);
});
test("anonymous IP identity receives broad NAT budget and expired buckets are pruned in bounded batches",async()=>{
 await admit("feed_page",ip,ip);
 await db.exec("update abuse_private.buckets set requests=119 where subject like 'a:%'");
 expect((await admit("feed_page",ip,ip)).allowed).toBe(true);
 await db.exec("insert into abuse_private.buckets(action,subject,window_seconds,window_start) select 'feed_page','old-'||n,60,now()-interval '3 days' from generate_series(1,150)n");
 await admit("search",actor,ip);
 expect((await db.query("select count(*)::int count from abuse_private.buckets where subject like 'old-%'")).rows).toEqual([{count:50}]);
});
