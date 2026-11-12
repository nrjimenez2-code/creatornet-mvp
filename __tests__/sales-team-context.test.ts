const account=jest.fn(),transport=jest.fn();
jest.mock("stripe",()=>jest.fn().mockImplementation(()=>({accounts:{retrieve:(...args:unknown[])=>account(...args)}})));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({})}));
import {createTeamPaymentContext} from "@/lib/salesTeams/context";
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const env={STRIPE_SECRET_KEY:"sk_test_fixture",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"pk_test_fixture",SUPABASE_SERVICE_ROLE_KEY:"fixture-service-only",
 VERCEL_ENV:"preview",CREATOR_TEAM_PAYMENT_CONTEXT:JSON.stringify(context),NEXT_PUBLIC_SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",NEXT_PUBLIC_SITE_URL:context.siteOrigin};
const url=env.NEXT_PUBLIC_SUPABASE_URL+"/rest/v1/sales_team_financial_config_v1?select=context&singleton=eq.true";
beforeEach(()=>{jest.clearAllMocks();account.mockResolvedValue({id:"acct_platform"});transport.mockResolvedValue({ok:true,url,json:async()=>[{context}]});});
test("team context is observed through the approved platform and authenticated project endpoint using reads only",async()=>{
 const client=createTeamPaymentContext(env,transport);expect(await client.observeContext()).toEqual(context);
 expect(transport).toHaveBeenCalledWith(url,expect.objectContaining({method:"GET",redirect:"error",cache:"no-store"}));expect(account).toHaveBeenCalledTimes(1);
});
test("a mismatched account, pin or final project URL fails closed",async()=>{
 const client=createTeamPaymentContext(env,transport);account.mockResolvedValueOnce({id:"acct_foreign"});await expect(client.observeContext()).rejects.toThrow();
 transport.mockResolvedValueOnce({ok:true,url:"https://foreign.supabase.co",json:async()=>[{context}]});await expect(client.observeContext()).rejects.toThrow();
 transport.mockResolvedValueOnce({ok:true,url,json:async()=>[{context:{...context,mode:"live"}}]});await expect(client.observeContext()).rejects.toThrow();
});
test("absent or mixed TEST/LIVE configuration never reaches a provider",()=>{
 for(const bad of [{...env,CREATOR_TEAM_PAYMENT_CONTEXT:"null"},{...env,VERCEL_ENV:"production"},{...env,NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"pk_live_fixture"},{...env,NEXT_PUBLIC_SUPABASE_URL:"https://foreign.supabase.co"}])expect(()=>createTeamPaymentContext(bad,transport)).toThrow();
 expect(account).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
