import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {locateTeamPaymentEvent} from "@/lib/salesTeams/webhook";
const rpc=jest.fn(),rawRequest=jest.fn(),original=jest.fn(),query={select:()=>query,eq:()=>query,maybeSingle:()=>original()},admin={rpc,from:()=>query} as unknown as SupabaseClient,stripe={rawRequest} as Pick<Stripe,"rawRequest">;
const event=(metadata:Record<string,string>={})=>({id:"evt_locator",type:"payment_intent.succeeded",livemode:false,data:{object:{id:"pi_original",object:"payment_intent",livemode:false,metadata}}}) as unknown as Stripe.Event;
beforeEach(()=>{jest.resetAllMocks();original.mockResolvedValue({data:null,error:{code:"PGRST205"}});});
test("a genuinely uninstalled schema preserves an unmarked legacy payment",async()=>{
 rpc.mockResolvedValue({data:null,error:{code:"PGRST202"}});expect(await locateTeamPaymentEvent({event:event(),admin,stripe})).toBeNull();expect(rawRequest).not.toHaveBeenCalled();
});
test("a marked payment cannot fall through when the schema is missing",async()=>{
 rpc.mockResolvedValue({data:null,error:{code:"PGRST202"}});await expect(locateTeamPaymentEvent({event:event({team_protocol:"creatornet-team-distribution-v1"}),admin,stripe})).rejects.toThrow();
});
test.each(["42501","57014","PGRST000"])("database error %s cannot downgrade original ownership to legacy",async code=>{
 rpc.mockResolvedValue({data:null,error:{code}});await expect(locateTeamPaymentEvent({event:event(),admin,stripe})).rejects.toEqual({code});
});
test("metadata is only a fence and never a substitute for the saved original",async()=>{
 rpc.mockResolvedValue({data:null,error:null});await expect(locateTeamPaymentEvent({event:event({team_protocol:"creatornet-team-distribution-v1"}),admin,stripe})).rejects.toThrow();
 expect(await locateTeamPaymentEvent({event:event(),admin,stripe})).toBeNull();
});
test("a missing locator cannot erase journal ownership after source flags are disabled",async()=>{
 rpc.mockResolvedValue({data:null,error:{code:"PGRST202"}});original.mockResolvedValue({data:{id:"original-operation"},error:null});
 await expect(locateTeamPaymentEvent({event:event(),admin,stripe})).rejects.toThrow();
});
