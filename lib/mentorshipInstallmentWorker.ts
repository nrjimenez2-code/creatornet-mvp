import "server-only";
import {createClient, type SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext, type ExactPaymentContext} from "./installments/paymentContext";
import {collectBuyerMentorshipInvoice} from "./mentorshipInstallmentCollection";
import {recoverBuyerMentorshipPayment} from "./mentorshipInstallmentPaymentRecovery";

type Env=Record<string,string|undefined>;
type Result={status:string;outcome?:string;futureCollection?:string};
type Identity={buyerId:string;requestId:string;env:Env};
type Dependencies={admin:SupabaseClient;context:ExactPaymentContext;observe:()=>Promise<unknown>;
  collect:(args:Identity)=>Promise<Result>;recover:(args:Identity&{invoiceId:string})=>Promise<Result>};
function check(value:unknown):asserts value {if(!value)throw Error("Buyer billing worker requires review");}
const enabled=(env:Env,keys:string[])=>keys.every(key=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${key}`]==="true");
export function buyerMentorshipWorkerReady(env:Env=process.env) {
  return env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY==="true" && enabled(env,["WORKER_SCHEMA_READY","WORKER_READY",
    "LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY"]);
}
export function buyerMentorshipWorkerCollectionReady(env:Env=process.env) {
  return buyerMentorshipWorkerReady(env) && enabled(env,["WORKER_COLLECTION_READY","BOOTSTRAP_SCHEMA_READY",
    "RECEIPT_INSPECTION_READY","ACTIVATION_SCHEMA_READY","COLLECTION_PERIODS_SCHEMA_READY","DISCOVERY_READY",
    "INVOICE_OPERATIONS_SCHEMA_READY","INVOICE_PREPARATION_READY","DEBIT_SCHEMA_READY","COLLECTION_READY"]);
}
/** Store only bounded result codes, never raw provider errors or financial data. */
export function buyerMentorshipWorkStatus(result:Result) {
  if(result.status==="credited" || result.status==="already_credited")return "accounted";
  if(result.status==="payment_recovery_recorded") {
    if(result.outcome==="paid_accounted")return result.futureCollection==="review_required"?"review_required":"accounted";
    if(result.outcome==="payment_pending")return "payment_pending";
    return "review_required";
  }
  if(result.status==="nothing_due")return "nothing_due";
  if(result.status==="waiting_for_invoice")return "waiting_for_invoice";
  if(result.status==="busy")return "busy";
  return "review_required";
}

/** One bounded batch on the existing collection schedule. A job lease is not
 * debit authority: original invoice preparation/admission remains authoritative.
 * Previously admitted work uses recovery directly, even while collection is off. */
export async function runBuyerMentorshipBillingWorker(env:Env=process.env,injected?:Dependencies) {
  check(buyerMentorshipWorkerReady(env));
  let deps=injected;
  if(!deps) {
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    deps={admin:createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}}),
      context:config.approvedContext,observe:async()=>validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence),
      collect:collectBuyerMentorshipInvoice,recover:recoverBuyerMentorshipPayment};
  }
  const {admin,context,observe,collect,recover}=deps;
  await observe();
  const canCollect=buyerMentorshipWorkerCollectionReady(env);
  const leased=await admin.rpc("lease_buyer_mentorship_work_v1",{p_context:context,p_collect:canCollect,p_limit:2});
  check(!leased.error && Array.isArray(leased.data) && leased.data.length<=2);
  const ids=new Set<string>();
  const rows=leased.data.map((row:Record<string,unknown>)=>{
    check(typeof row.reservation_id==="string" && typeof row.request_id==="string" && typeof row.buyer_id==="string" && typeof row.lease_token==="string");
    assertAgreementId(row.reservation_id);assertAgreementId(row.request_id);assertAgreementId(row.buyer_id);assertAgreementId(row.lease_token);
    check(!ids.has(row.reservation_id) && ["collect","recover","review"].includes(String(row.action)));
    check(row.action!=="collect" || canCollect);
    check(row.action!=="recover" || typeof row.invoice_id==="string" && /^in_[A-Za-z0-9]+$/.test(row.invoice_id));
    ids.add(row.reservation_id);return row;
  });
  const settled=await Promise.allSettled(rows.map(async row=>{
    let status:string="review_required";
    try {
      await observe();
      const args={buyerId:row.buyer_id as string,requestId:row.request_id as string,env};
      if(row.action==="recover")status=buyerMentorshipWorkStatus(await recover({...args,invoiceId:row.invoice_id as string}));
      else if(row.action==="collect")status=buyerMentorshipWorkStatus(await collect(args));
    } catch {status="retry_required";}
    await observe();
    const finished=await admin.rpc("finish_buyer_mentorship_work_v1",{p_reservation_id:row.reservation_id,p_token:row.lease_token,p_context:context,p_status:status});
    check(!finished.error && finished.data===true);return status;
  }));
  // Do not return while another leased job is still waiting for its provider.
  check(settled.every(result=>result.status==="fulfilled"));
  await observe();
  const summary=await admin.rpc("read_buyer_mentorship_work_summary_v1",{p_context:context});
  check(!summary.error && summary.data && ["pending","attention"].every(key=>Number.isSafeInteger(summary.data[key]) && summary.data[key]>=0));
  return {selected:rows.length,failed:settled.filter(result=>result.status==="fulfilled" && result.value==="retry_required").length,
    needsReview:summary.data.attention as number,pending:summary.data.pending as number};
}
