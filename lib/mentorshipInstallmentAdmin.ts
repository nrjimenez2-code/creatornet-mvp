import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
import {validMembershipAdminCursor} from "./membershipAdmin";

type Env=Record<string,string|undefined>;
const pageSize=25;
function check(v:unknown):asserts v {if(!v)throw Error("Buyer billing review unavailable");}
const record=(v:unknown):Record<string,unknown>=>{check(v!==null && typeof v==="object" && !Array.isArray(v));return v as Record<string,unknown>;};
const count=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>{check(typeof v==="number" && Number.isSafeInteger(v) && v>=min && v<=max);return v;};
const time=(v:unknown)=>{check(v===null || typeof v==="string" && Number.isFinite(Date.parse(v)));return v as string|null;};
const epoch=(v:unknown)=>v===null?null:count(v,1,253402300799);
const enumOrNull=(v:unknown,choices:string[])=>{check(v===null || typeof v==="string" && choices.includes(v));return v as string|null;};
export function buyerMentorshipAdminReady(env:Env=process.env) {
  return env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY==="true" && ["ADMIN_READY","ADMIN_SCHEMA_READY","WORKER_SCHEMA_READY","RECOVERY_SCHEMA_READY"]
    .every(key=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${key}`]==="true");
}
/** Strictly project the service result; never forward a raw database record. */
export function parseBuyerMentorshipAdminPage(value:unknown,context:ExactPaymentContext,cursor:string|null) {
  const root=record(value),backlog=record(root.backlog);
  check(isDeepStrictEqual(root.context,context) && Array.isArray(root.rows) && root.rows.length<=pageSize+1);
  const observedAt=time(root.observedAt);check(observedAt!==null);
  let previousId=cursor?.toLowerCase()??"";
  const rows=root.rows.map(value=>{
    const r=record(value);
    check(validMembershipAdminCursor(r.id) && r.id===r.id.toLowerCase() && validMembershipAdminCursor(r.request_id) &&
      isDeepStrictEqual(r.context,context) && r.id>previousId);
    previousId=r.id;
    check(typeof r.title==="string" && r.title.length>0 && r.title.length<=1000);
    const paymentCount=count(r.payment_count,2,24),paidCount=count(r.paid_count,1,paymentCount);
    const recoveryInvoice=r.recovery_invoice_id;
    check(recoveryInvoice===null || typeof recoveryInvoice==="string" && /^in_[A-Za-z0-9]+$/.test(recoveryInvoice));
    const recoveryNumber=r.recovery_payment_number===null?null:count(r.recovery_payment_number,2,paymentCount);
    check((recoveryInvoice===null)===(recoveryNumber===null));
    const recoveryOutcome=enumOrNull(r.recovery_outcome,["action_required","payment_method_required","payment_pending","terminal_unpaid","paid_accounted","review_required"]);
    const recoveryObservedAt=time(r.recovery_observed_at);
    check(recoveryInvoice!==null || recoveryOutcome===null && recoveryObservedAt===null);
    return {id:r.id,requestId:r.request_id,title:r.title,amountCents:count(r.amount_cents,100),paymentCount,paidCount,
      serviceMonths:r.service_months===null?null:count(r.service_months,1,1200),nextPaymentAt:epoch(r.next_payment_at),serviceEndAt:epoch(r.service_end_at),
      holds:[time(r.collection_hold_at)&&"Collection held",time(r.financial_hold_at)&&"Financial hold",time(r.debit_revoked_at)&&"Automatic debits revoked"].filter((x):x is string=>!!x),
      workerStatus:enumOrNull(r.worker_status,["running","accounted","nothing_due","waiting_for_invoice","busy","payment_pending","review_required","retry_required"]),
      nextAttemptAt:time(r.next_attempt_at),lastAttemptAt:time(r.last_attempt_at),leaseUntil:time(r.lease_until),
      dueAction:enumOrNull(r.due_action,["collect","recover","review"]),recoveryInvoice,recoveryNumber,recoveryOutcome,recoveryObservedAt};
  });
  return {mode:context.mode,observedAt,pending:count(backlog.pending),attention:count(backlog.attention),oldestDueAt:epoch(root.oldestDueAt),
    plans:rows.slice(0,pageSize),nextCursor:rows.length>pageSize?rows[pageSize-1].id:null};
}
/** Caller must requireAdmin before calling. Independent context observation is
 * read-only. This function has no payment or operator mutation capability. */
export async function readBuyerMentorshipAdminPage(admin:SupabaseClient,cursor:string|null,env:Env=process.env) {
  check(buyerMentorshipAdminReady(env) && (cursor===null || validMembershipAdminCursor(cursor)));
  const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
  const context=validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence);
  const result=await admin.rpc("read_buyer_mentorship_admin_page_v1",{p_context:context,p_after:cursor,p_limit:pageSize});
  check(!result.error);
  return parseBuyerMentorshipAdminPage(result.data,context,cursor);
}
