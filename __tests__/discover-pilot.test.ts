import { assignDiscoverPilot, pilotVariant } from "@/lib/discoverPilot";
import { rankDiscover, type DiscoverCandidate, type DiscoverEvidence } from "@/lib/discoverRanking";
import type { SupabaseClient } from "@supabase/supabase-js";

test("stable assignment has both arms and is independent of session time", () => {
  const arms = Array.from({length:1000},(_,i)=>pilotVariant("trial-1",`user-${i}`));
  expect(arms.filter(x=>x==='control').length).toBeGreaterThan(400);
  expect(arms.filter(x=>x==='commercial').length).toBeGreaterThan(400);
  expect(pilotVariant("trial-1","user-1")).toBe(pilotVariant("trial-1","user-1"));
});

test("off, anonymous and Following never access experiment data", async () => {
  const from = jest.fn();
  const db = {from} as unknown as SupabaseClient;
  expect(await assignDiscoverPilot(db,"user","discover","")).toBeNull();
  expect(await assignDiscoverPilot(db,null,"discover","trial")).toBeNull();
  expect(await assignDiscoverPilot(db,"user","following","trial")).toBeNull();
  expect(from).not.toHaveBeenCalled();
});

test("enrollment preserves stored arm and fails instead of silently changing treatment", async () => {
  const upsert = jest.fn().mockResolvedValue({error:null});
  const experiment = {id:'trial',enabled:true,policy_version:'commercial-order-v1',starts_at:'2026-09-01',ends_at:'2026-10-01'};
  let assigned: unknown = {variant:'control'};
  const from = jest.fn((table:string)=>{
    const chain = {select:()=>chain,eq:()=>chain,single:async()=>({data:table==='discover_pilots_v1'?experiment:assigned,error:null}),upsert};
    return chain;
  });
  const db = {from} as unknown as SupabaseClient;
  const now = Date.parse('2026-09-14');
  expect(await assignDiscoverPilot(db,'viewer','discover','trial',now)).toEqual({experimentId:'trial',variant:'control'});
  expect(upsert).toHaveBeenCalledWith(expect.anything(),{onConflict:'experiment_id,user_id',ignoreDuplicates:true});
  assigned = null;
  await expect(assignDiscoverPilot(db,'viewer','discover','trial',now)).rejects.toThrow('assignment unavailable');
  experiment.enabled=false;
  expect(await assignDiscoverPilot(db,'viewer','discover','trial',now)).toBeNull();
});

test("control removes commercial ordering while retaining the same inventory", () => {
  const now=Date.parse('2026-09-14');
  const posts:DiscoverCandidate[]=['a','b','c'].map(id=>({id,creator_id:id,created_at:new Date(now).toISOString(),interests:['technology & ai'],offer_type:'course'}));
  const evidence:DiscoverEvidence[]=posts.map(p=>({post_id:p.id,audience:'',exposures:100,sales:p.id==='c'?40:0,bookings:0,intents:0,taps:0,views:0,commercial:0,last_exposure:new Date(now).toISOString()}));
  const ranked=(commercialOrdering:boolean)=>rankDiscover(posts,[],'viewer',['technology & ai'],[],now,[],evidence,{commercialOrdering});
  expect(ranked(true)[0]).toBe('c');
  expect(ranked(false)).toEqual(['a','b','c']);
  expect([...ranked(true)].sort()).toEqual([...ranked(false)].sort());
});
