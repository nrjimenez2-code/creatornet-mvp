import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import {readFileSync} from "node:fs";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "./sales-team-shared-cash-postgres";
import {seedTeamCapture,captureRpc} from "./sales-team-capture-postgres";
import {teamSupabaseFixture} from "./sales-team-supabase-fixture";
import {teamFixtureId as id} from "./sales-team-postgres";
import {teamPaymentFixture} from "./sales-team-payment-fixture";
import {inspectTeamConfirmationToken} from "@/lib/salesTeams/paymentProtocol";
import {recordTeamSavedMethod,type TeamSavedMethodQuote} from "@/lib/salesTeams/savedMethod";
export const savedMethodCandidate="supabase/migrations/20261027021620_sales_team_saved_method_authority.sql";
export const savedMethodPredecessors=[sharedCashReconciliationCandidate,...["20261023042321_sales_team_retained_refund_funding.sql","20261023060912_sales_team_automatic_recovery.sql","20261023063905_sales_team_worker_refund_recovery.sql","20261023174324_sales_team_no_outbound_shared_recovery.sql","20261023180144_sales_team_transfer_reservations.sql","20261023182527_sales_team_transfer_observations.sql","20261023184139_sales_team_transfer_execution.sql","20261023190044_sales_team_automatic_settlement.sql","20261024210829_sales_team_transfer_reversal_observations.sql","20261024213841_sales_team_transfer_recovery_reservations.sql","20261024215948_sales_team_transfer_recovery_execution.sql","20261025184802_sales_team_transfer_reversal_recovery.sql","20261025191826_sales_team_combined_settlement.sql","20261025195351_sales_team_later_collection.sql","20261026185425_sales_team_payment_lifecycle.sql","20261026193046_sales_team_expired_collection_retry.sql"].map(n=>`supabase/migrations/${n}`)];
export async function savedMethodDatabase(db:PGlite){await sharedCashDatabase(db);for(const file of [...savedMethodPredecessors,savedMethodCandidate])await db.exec(readFileSync(file,"utf8"));return db;}
/** Existing consent/capture/Library/GET-only method authorities, not a synthetic
 * insert into a new automatic authority table. No provider account is contacted. */
export async function seedTeamSavedMethod(db:PGlite,monthly?:{minimumMonths:number;autoRenew:boolean}){
 const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);let token:Stripe.ConfirmationToken;
 await db.exec("update sales_team_controls_v1 set fulfillment_enabled=true,event_reconciliation_enabled=true,financial_reconciliation_enabled=true");
 const f=await seedTeamCapture(db,{paymentKind:monthly?"monthly":"installments",beforeApproval:monthly?async()=>{await db.query("update products set type='mentorship',membership_terms=$1",[{version:"monthly-mentorship-v1",...monthly}]);}:undefined,
  beforeConfirmation:async(contract,baseProof)=>{token=JSON.parse(JSON.stringify(teamPaymentFixture(monthly?"monthly":"installments").token));token.created=baseProof.createdAt;token.expires_at=baseProof.expiresAt;token.payment_method_preview!.card!.fingerprint="fp_saved";
   const proof=inspectTeamConfirmationToken(contract,teamPaymentFixture().evidence,token,token.id,baseProof.createdAt),quote=await rpc<TeamSavedMethodQuote>("read_sales_team_saved_method_quote_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId]);await db.exec("update sales_team_controls_v1 set saved_method_enabled=true");
   await rpc("accept_sales_team_saved_method_v1",[contract.saleId,contract.terms.buyerId,contract.obligationId,id(70),contract.context,quote.fingerprint,true,proof]);return proof;}});
 const receipt=await f.record();await rpc("fulfill_sales_team_receipt_v1",[f.sale,f.buyer,receipt.id]);token!.payment_intent="pi_original";token!.expires_at=null;
 const method={object:"payment_method",id:"pm_original",livemode:false,type:"card",customer:"cus_original",card:{...token!.payment_method_preview!.card},billing_details:token!.payment_method_preview!.billing_details} as unknown as Stripe.PaymentMethod;
 let n=0;const rawRequest=async(http:string,path:string)=>{if(http!=="GET")throw Error("Fixture saved-card writer is GET-only");const value=path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/confirmation_tokens/ctoken_original"?token:path==="/v1/payment_methods/pm_original"?method:null;if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_seedSaved${++n}`}}));};
 const c={admin:teamSupabaseFixture(db),stripe:{rawRequest:rawRequest as Stripe["rawRequest"]},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
 await recordTeamSavedMethod(c,f.sale,f.buyer);return {...f,method,token:token!,receiptId:receipt.id,c};
}
