import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipAccessSeconds, membershipLedgerReady } from "../lib/membershipAccess";
const rpc=jest.fn(), admin={rpc} as unknown as SupabaseClient;
const keys=["CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_SCHEMA_READY","CREATOR_MENTORSHIP_INSTALLMENT_ACCESS_READY",
  "CREATOR_FIXED_SERVICE_SCHEMA_READY","CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY"];
const original=keys.map(key=>process.env[key]);
beforeEach(()=>{rpc.mockReset();for(const key of keys) process.env[key]="true";});
afterAll(()=>keys.forEach((key,i)=>{if(original[i]===undefined)delete process.env[key];else process.env[key]=original[i];}));
test("owned buyer entitlement is authoritative before fixed/monthly/legacy fallback",async()=>{
  rpc.mockResolvedValue({data:{applicable:true,allowed:true,maxAgeSeconds:17},error:null});
  expect(membershipLedgerReady()).toBe(true);expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(17);
  expect(rpc.mock.calls).toEqual([["read_buyer_mentorship_entitlement_v1",{p_purchase_id:"purchase",p_buyer_id:"buyer"}]]);
});
test.each([null,{}, {applicable:true,allowed:false,maxAgeSeconds:0},{applicable:true,allowed:true,maxAgeSeconds:3601},
  {applicable:true,allowed:true,maxAgeSeconds:"30"}])("malformed or denied %p does not fall through",async data=>{
  rpc.mockResolvedValue({data,error:null});expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(0);
  expect(rpc).toHaveBeenCalledTimes(1);
});
test("RPC error never adopts a fallback",async()=>{
  rpc.mockResolvedValue({data:{applicable:false,allowed:true,maxAgeSeconds:3600},error:{message:"unavailable"}});
  expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(0);expect(rpc).toHaveBeenCalledTimes(1);
});
test("unrelated purchases retain the fixed reader",async()=>{
  rpc.mockResolvedValueOnce({data:{applicable:false,allowed:false,maxAgeSeconds:0},error:null})
    .mockResolvedValueOnce({data:{applicable:true,allowed:true,maxAgeSeconds:21},error:null});
  expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(21);
  expect(rpc.mock.calls.map(c=>c[0])).toEqual(["read_buyer_mentorship_entitlement_v1","read_fixed_service_entitlement_v1"]);
});
test("buyer-only rollout preserves owned legacy result",async()=>{
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY="false";process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY="false";
  rpc.mockResolvedValue({data:{applicable:false,allowed:true,maxAgeSeconds:3600},error:null});
  expect(membershipLedgerReady()).toBe(true);expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(3600);
  expect(rpc).toHaveBeenCalledTimes(1);
});
test.each(keys.slice(0,2))("missing %s leaves buyer reader disabled",async key=>{
  delete process.env[key];rpc.mockResolvedValue({data:{applicable:true,allowed:false,maxAgeSeconds:0},error:null});
  expect(await membershipAccessSeconds(admin,"purchase","buyer")).toBe(0);
  expect(rpc.mock.calls.map(c=>c[0])).toEqual(["read_fixed_service_entitlement_v1"]);
});
