import "server-only";
import {createClient, type SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
type Env=Record<string,string|undefined>;
type Dependencies={admin:SupabaseClient;context:ExactPaymentContext;observe:()=>Promise<unknown>};
function check(value:unknown):asserts value {if(!value)throw Error("Full payment refund review unavailable");}
export const fullRefundReviewReady=(env:Env=process.env)=>env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY==="true" &&
  env.CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY==="true" && env.CREATOR_FULL_REFUND_REVIEW_MONITOR_READY==="true";

/** Authenticated cron/admin callers only. Read-only counts; never provider work,
 * receipt accounting, hold clearing or acknowledgement of alert delivery. */
export async function readFullRefundReviewBacklog(env:Env=process.env,injected?:Dependencies) {
  check(fullRefundReviewReady(env));
  let deps=injected;
  if(!deps) {
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    deps={admin:createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}}),
      context:config.approvedContext,observe:async()=>validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence)};
  }
  await deps.observe();
  const {data,error}=await deps.admin.rpc("read_full_refund_review_backlog_v1",{p_context:deps.context});
  check(!error && data && isDeepStrictEqual(data.context,deps.context));
  for(const key of ["needsReview","events","unapplied","reviewRecorded"])check(Number.isSafeInteger(data[key]) && data[key]>=0);
  check(data.needsReview<=data.events && data.unapplied<=data.events && data.reviewRecorded<=data.events &&
    (data.events===0)===(data.needsReview===0) && typeof data.observedAt==="string" && Number.isFinite(Date.parse(data.observedAt)));
  check(data.events===0?data.oldestObservedAt===null:typeof data.oldestObservedAt==="string" &&
    Number.isFinite(Date.parse(data.oldestObservedAt)) && Date.parse(data.oldestObservedAt)<=Date.parse(data.observedAt));
  await deps.observe();
  return {needsReview:data.needsReview as number,events:data.events as number,unapplied:data.unapplied as number,
    reviewRecorded:data.reviewRecorded as number,observedAt:data.observedAt as string,oldestObservedAt:data.oldestObservedAt as string|null};
}
