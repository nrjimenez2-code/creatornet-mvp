import type {PGlite} from "@electric-sql/pglite";
import {seedTeamCapture} from "./sales-team-capture-postgres";
import {teamFixtureId as id} from "./sales-team-postgres";
import {teamSupabaseFixture} from "./sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "./sales-team-cash-postgres";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer} from "@/lib/salesTeams/transferReservations";
import {observeTeamAdmittedTransfer} from "@/lib/salesTeams/transferObservations";
import {observeTeamBeneficiaryPayout} from "@/lib/salesTeams/beneficiaryPayoutObservations";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

/** Structural shared schema and fake provider only; creates an original through
 * the retained capture, reservation, journal and F27 completion owners. */
export async function seedCompletedBeneficiary(db:PGlite){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true");
 const f=await seedTeamCapture(db),stamp=Math.floor(Date.now()/1000);f.base.balance.available_on=stamp;f.base.balance.status="available";
 const receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic beneficiary fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 const values:Record<string,Record<string,unknown>>={"/v1/balance":teamCashBalanceFixture,"/v1/payment_intents/pi_original":f.base.paymentIntent as unknown as Record<string,unknown>,
  "/v1/charges/ch_original":f.base.charge as unknown as Record<string,unknown>,"/v1/balance_transactions/txn_original":f.base.balance as unknown as Record<string,unknown>,
  "/v1/refunds":{object:"list",data:[],has_more:false},"/v1/disputes":{object:"list",data:[],has_more:false}};
 let sequence=0;const raw=jest.fn(async(method:string,path:string,_params?:Record<string,unknown>,options?:Record<string,unknown>)=>{
  if(method!=="GET")throw Error("No provider writes in beneficiary fixture");
  const value=values[(options?.stripeAccount?"connected:":"")+path];if(!value)throw Error(`Unexpected fixture path ${path}`);
  return {...JSON.parse(JSON.stringify(value)),lastResponse:{requestId:`req_beneficiary${++sequence}`}};
 });
 const base=teamSupabaseFixture(db),rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  await db.exec("savepoint beneficiary_rpc");const result=await base.rpc(name,args);
  if(result.error)await db.exec("rollback to savepoint beneficiary_rpc");await db.exec("release savepoint beneficiary_rpc");return result;
 });
 const c={admin:{rpc},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const invoke=async<T=unknown>(name:string,args:Record<string,unknown>):Promise<T>=>{const result=await rpc(name,args);if(result.error)throw result.error;return result.data as T;};
 await inspectTeamReceiptFinancials(c,receiptId,id(29));
 const run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 const journal=await f.rpc<{operation:{lease_token:string}}>("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
 await f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"assert",{operationId:q.operation_id,leaseToken:journal.operation.lease_token}]);
 await f.rpc("bind_sales_team_provider_operation_v1",[q.operation_id,"tr_original","req_originalPost",false]);
 const amount=Number(q.amount_cents),transfer={id:"tr_original",object:"transfer",amount,amount_reversed:0,balance_transaction:"txn_transfer",created:stamp,currency:"usd",destination:q.destination_id,destination_payment:"py_destination",livemode:false,metadata:q.request.params.metadata,reversed:false,reversals:{object:"list",data:[],has_more:false,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${q.sale_id}`};
 const balance={id:"txn_transfer",object:"balance_transaction",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",amount:-amount,fee:0,net:-amount,exchange_rate:null,created:stamp,available_on:stamp,status:"available",fee_details:[]};
 values["/v1/transfers/tr_original"]=transfer;values["/v1/balance_transactions/txn_transfer"]=balance;
 await observeTeamAdmittedTransfer(c,{...run,taskId:id(82),requestId:q.id,checkId:id(85)});
 const credit={...balance,id:"txn_credit",source:"py_destination",type:"payment",reporting_category:"transfer",amount,net:amount};
 const payout={id:"po_original",object:"payout",amount,automatic:true,method:"standard",type:"bank_account",status:"paid",currency:"usd",destination:"ba_original",created:stamp,arrival_date:stamp,livemode:false,reconciliation_status:"completed",balance_transaction:"txn_payout",failure_balance_transaction:null as string|null,failure_code:null as string|null,original_payout:null,reversed_by:null};
 const payoutDebit={...balance,id:"txn_payout",source:"po_original",type:"payout",reporting_category:"payout"};
 values["connected:/v1/payouts/po_original"]=payout;values["connected:/v1/balance_transactions"]={object:"list",url:"/v1/balance_transactions",data:[credit],has_more:false};
 values["connected:/v1/balance_transactions/txn_credit"]=credit;values["connected:/v1/balance_transactions/txn_payout"]=payoutDebit;
 await db.exec("update sales_team_bank_observation_policy_v1 set enabled=true,contract_sha256=creatornet_team_private.bank_observation_contract_digest_v1()");
 raw.mockClear();rpc.mockClear();
 return {c,q,raw,rpc,invoke,payout,payoutDebit,credit,transfer,values,
  observe:(checkId=id(500))=>observeTeamBeneficiaryPayout(c,{checkId,requestId:q.id,payoutId:payout.id})};
}
