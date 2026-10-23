import type Stripe from "stripe";
jest.mock("@/lib/salesTeams/server",()=>{throw Error("Restricted cash readback imported a database client");});
jest.mock("@/lib/salesTeams/context",()=>{throw Error("Restricted cash readback imported a credential factory");});
import {readTeamCashProof} from "@/lib/salesTeams/cashReadback";
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const balance=(requestId:string)=>({object:"balance",livemode:false,available:[{currency:"usd",amount:10000,source_types:{card:10000}}],lastResponse:{requestId}}) as Stripe.Response<Stripe.Balance>;
afterEach(()=>{jest.useRealTimers();});
test("restricted readback uses only its supplied balance transport and retains real read identities",async()=>{
 const observe=jest.fn(async()=>context),read=jest.fn().mockResolvedValueOnce(balance("req_first")).mockResolvedValueOnce(balance("req_second"));
 expect(await readTeamCashProof(context,observe,read)).toMatchObject({context,availableCents:10000,firstRequestId:"req_first",secondRequestId:"req_second"});
 expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls.every(([timeout])=>timeout>0&&timeout<=10000)).toBe(true);
});
test("a slow final context check cannot return a proof outside the admission budget",async()=>{
 jest.useFakeTimers({now:Date.parse("2026-10-22T20:00:00Z")});let observations=0;
 const observe=async()=>{if(++observations===2)jest.advanceTimersByTime(20001);return context;};
 const read=jest.fn(async()=>balance("req_bounded"));
 await expect(readTeamCashProof(context,observe,read)).rejects.toThrow(/funds require review/);expect(read).toHaveBeenCalledTimes(2);
});
test("the second transport timeout is capped to its remaining budget",async()=>{
 jest.useFakeTimers({now:Date.parse("2026-10-22T20:00:00Z")});let reads=0;
 const read=jest.fn(async()=>{if(++reads===1)jest.advanceTimersByTime(16000);return balance(`req_budget${reads}`);});
 await readTeamCashProof(context,async()=>context,read);expect(read.mock.calls).toEqual([[10000],[4000]]);
});
