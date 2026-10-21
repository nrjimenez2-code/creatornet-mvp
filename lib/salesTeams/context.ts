import "server-only";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { validateExactPaymentContext,type ExactPaymentContext,type ExactPaymentContextEvidence } from "@/lib/installments/paymentContext";
import { TEAM_STRIPE_API_VERSION } from "./providerOperation";
import { TeamSalesError } from "./policy";

/** Explicit server composition, never inferred from event metadata or a buyer.
 * The new protocol has its own approved pin and does not reuse an old trial's
 * account/project/site authority. Credentials are read only by the runtime. */
export function createTeamPaymentContext(env:Record<string,string|undefined>=process.env,transport:typeof fetch=globalThis.fetch){
 const fail=()=>new TeamSalesError("TEAM_PAYMENT_CONTEXT_INVALID","The approved team-payment environment needs review.");
 const secret=env.STRIPE_SECRET_KEY||"",publishable=env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY||"",service=env.SUPABASE_SERVICE_ROLE_KEY||"";
 const mode=/^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(secret)?.[1],publicMode=/^pk_(test|live)_[A-Za-z0-9]+$/.exec(publishable)?.[1];
 if(!mode||mode!==publicMode||!service||env.VERCEL_ENV!==(mode==="live"?"production":"preview"))throw fail();
 let approved:ExactPaymentContext;
 try{approved=JSON.parse(env.CREATOR_TEAM_PAYMENT_CONTEXT||"");}catch{throw fail();}
 if(!approved||typeof approved!=="object"||Array.isArray(approved))throw fail();
 const candidate={approvedContext:approved,vercelEnvironment:env.VERCEL_ENV,stripeSecretKeyMode:mode,stripePublishableKeyMode:publicMode,
  observedPlatformAccountId:approved.platformAccountId,observedSupabaseProjectRef:approved.supabaseProjectRef,
  configuredSupabaseUrl:env.NEXT_PUBLIC_SUPABASE_URL,configuredSiteOrigin:env.NEXT_PUBLIC_SITE_URL};
 let context:ExactPaymentContext;
 try{context=validateExactPaymentContext(approved,candidate);}catch{throw fail();}
 const stripe=new Stripe(secret,{timeout:10000,maxNetworkRetries:0});
 const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,service,{auth:{persistSession:false,autoRefreshToken:false}});
 const pinUrl=new URL("/rest/v1/sales_team_financial_config_v1?select=context&singleton=eq.true",env.NEXT_PUBLIC_SUPABASE_URL).toString();
 async function observeEvidence():Promise<ExactPaymentContextEvidence>{
  const started=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const [account,pin]=await Promise.all([
    stripe.accounts.retrieve({},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}),
    transport(pinUrl,{method:"GET",headers:{apikey:service,Authorization:`Bearer ${service}`},redirect:"error",cache:"no-store",signal:controller.signal}),
   ]);
   if(!pin.ok||pin.url!==pinUrl||Date.now()<started||Date.now()-started>30000)throw fail();
   const rows=await pin.json();if(!Array.isArray(rows)||rows.length!==1||!isDeepStrictEqual(rows[0].context,context))throw fail();
   const evidence={approvedContext:context,vercelEnvironment:env.VERCEL_ENV as "preview"|"production",stripeSecretKeyMode:mode as "test"|"live",stripePublishableKeyMode:publicMode as "test"|"live",
    observedPlatformAccountId:account.id,observedSupabaseProjectRef:new URL(pin.url).hostname.split(".")[0],configuredSupabaseUrl:env.NEXT_PUBLIC_SUPABASE_URL!,configuredSiteOrigin:env.NEXT_PUBLIC_SITE_URL!};
   validateExactPaymentContext(context,evidence);return evidence;
  }catch{throw fail();}finally{clearTimeout(timer);}
 }
 return {context,stripe,admin,observeEvidence,observeContext:async()=>{await observeEvidence();return context;}};
}
