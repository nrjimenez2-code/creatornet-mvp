import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {teamRpc} from "./server";
import {teamId,TeamSalesError,teamAutomaticCollectionReady,teamLaterCollectionReady,teamSavedMethodReady} from "./policy";
import {readTeamCollection,prepareTeamCollection,teamCollectionView,readTeamOriginalIntent,observeTeamCollectionState,type TeamCollection} from "./collection";
import {inspectTeamPaymentIntent,type TeamPaymentContract} from "./paymentProtocol";
import {runTeamProviderOperation,teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {assertTeamSavedAuthority,inspectTeamReusableMethod,isTeamSavedAuthenticationRequired,teamSavedConfirmationRequest,type TeamSavedAuthority} from "./savedCollectionProtocol";
import type {TeamReceiptComposition} from "./receipts";
export type TeamAutomaticCollectionSource={payment:TeamCollection;automatic:{obligation_id:string;sale_id:string;buyer_id:string;consent_id:string;worker_run_id:string;request_id:string;context:TeamSavedAuthority["context"]};authority:TeamSavedAuthority};
export type TeamCollectionTask={id:string;run_id:string;obligation_id:string;kind:"new"|"original"};
type Worker={runId:string;leaseToken:string;task:TeamCollectionTask;canDispatch?:()=>boolean};
type Confirmation={operation_id:string;request_id:string;kind:"saved_method"|"saved_reconfirm";request:TeamProviderRequest;saved_method_consent_id:string};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw new TeamSalesError("TEAM_AUTOMATIC_COLLECTION_REVIEW_REQUIRED","The original automatic payment needs review. Refresh it before continuing.");};
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const objectId=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
export async function readTeamAutomaticCollection(c:Pick<TeamReceiptComposition,"admin">,saleId:string,buyerId:string,obligationId:string){return teamRpc<TeamAutomaticCollectionSource>(c.admin,"read_sales_team_automatic_collection_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),p_obligation_id:teamId(obligationId)});}
function contract(source:TeamAutomaticCollectionSource):TeamPaymentContract{
 const s=source.payment;if(s.attempt)return s.attempt.contract;check(s.obligation&&s.runtime?.customer_id&&s.collection_expires_at);
 return {protocol:s.sale.terms.protocol,saleId:s.sale.id,obligationId:s.obligation.id,operationId:teamOperationId({scopeId:s.sale.id,kind:"intent",scopeKey:`intent:${s.obligation.id}`}),terms:s.sale.terms,fingerprint:s.sale.fingerprint,context:s.sale.context,
  customerId:s.runtime.customer_id,periodNumber:s.obligation.period_number,amountCents:s.obligation.amount_cents,acceptedAt:Math.floor(Date.parse(s.sale.accepted_at)/1000),expiresAt:Math.floor(Date.parse(s.collection_expires_at)/1000),kind:"payment"};
}
async function get<T>(c:TeamReceiptComposition,path:string,params:Record<string,unknown>={}):Promise<T>{const value=await c.stripe.rawRequest("GET",path,params,options) as T;check(/^req_[A-Za-z0-9]+$/.test(requestId(value)));return value;}
async function checkedMethod(c:TeamReceiptComposition,source:TeamAutomaticCollectionSource){
 const started=Date.now();check(isDeepStrictEqual(c.context,source.automatic.context)&&isDeepStrictEqual(await c.observeContext(),c.context));
 const method=await get<Stripe.PaymentMethod>(c,`/v1/payment_methods/${source.authority.paymentMethodId}`),proof=inspectTeamReusableMethod(contract(source),source.authority,await c.observeEvidence(),method,Math.floor(Date.now()/1000));
 check(isDeepStrictEqual(await c.observeContext(),c.context)&&Date.now()>=started&&Date.now()-started<30000);
 return {...proof,context:c.context,providerRequestId:requestId(method),readStartedAt:started,observedAt:Math.floor(Date.now()/1000)};
}
async function recordMethod(c:TeamReceiptComposition,source:TeamAutomaticCollectionSource,checkId:string,worker?:Worker){
 await teamRpc(c.admin,"record_sales_team_automatic_method_v1",{p_sale_id:source.automatic.sale_id,p_buyer_id:source.automatic.buyer_id,p_obligation_id:source.automatic.obligation_id,p_check_id:checkId,p_proof:await checkedMethod(c,source),
  ...(worker?{p_run_id:worker.runId,p_lease_token:worker.leaseToken,p_task_id:worker.task.id}:{})});
}
/** Exact original-event evidence. A failed POST or an empty/incomplete lookup
 * never means unsent. This reader performs no POST and cannot choose another PI. */
async function originalConfirmationEvent(c:TeamReceiptComposition,source:TeamAutomaticCollectionSource,operationId:string,intentId:string){
 const started=Date.now();
 const operation=await c.admin.from("sales_team_provider_operations_v1").select("id,idempotency_key,first_dispatch_at").eq("id",operationId).maybeSingle();if(operation.error)throw operation.error;check(operation.data&&operation.data.idempotency_key===`cn-team-v1:${operationId}`);
 const events:Stripe.Event[]=[],seen=new Set<string>(),requests=new Set<string>();let after:string|undefined,complete=false;
 const types=["payment_intent.payment_failed","payment_intent.requires_action","payment_intent.processing","payment_intent.succeeded","payment_intent.canceled"];
 for(let page=0;page<3;page++){
  const list=await get<Stripe.ApiList<Stripe.Event>>(c,"/v1/events",{types,created:{gte:Math.floor(Date.parse(operation.data.first_dispatch_at)/1000)-5},limit:100,...(after?{starting_after:after}:{})});
  check(list.object==="list"&&Array.isArray(list.data)&&list.data.length<=100&&typeof list.has_more==="boolean"&&!requests.has(requestId(list)));requests.add(requestId(list));
  for(const event of list.data){check(event.object==="event"&&/^evt_[A-Za-z0-9]+$/.test(event.id)&&types.includes(event.type)&&!seen.has(event.id));seen.add(event.id);events.push(event);}
  if(!list.has_more){complete=true;break;}check(list.data.length>0);after=list.data.at(-1)!.id;
 }
 if(!complete)return null;const matches=events.filter(e=>e.request?.idempotency_key===operation.data!.idempotency_key);if(!matches.length)return null;
 const origin=matches[0].request?.id;check(/^req_[A-Za-z0-9]+$/.test(origin??"")&&!requests.has(origin!));
 for(const event of matches){check(event.account==null&&event.context==null&&event.livemode===(c.context.mode==="live")&&event.request?.id===origin&&Number.isSafeInteger(event.created)&&event.created>=Math.floor(Date.parse(operation.data.first_dispatch_at)/1000)-5&&event.created<=Math.floor(Date.now()/1000)+5&&typeof event.api_version==="string"&&/^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9_-]+)?$/.test(event.api_version));
  const snapshot=event.data.object as Stripe.PaymentIntent,expected:Record<string,string>={"payment_intent.payment_failed":"requires_payment_method","payment_intent.requires_action":"requires_action","payment_intent.processing":"processing","payment_intent.succeeded":"succeeded","payment_intent.canceled":"canceled"};inspectTeamPaymentIntent(contract(source),await c.observeEvidence(),snapshot,intentId);check(snapshot.status===expected[event.type]&&(!snapshot.payment_method||objectId(snapshot.payment_method)===source.authority.paymentMethodId));
 }
 const selected=matches[0],retrieved=await get<Stripe.Event>(c,`/v1/events/${selected.id}`);
 check(retrieved.id===selected.id&&retrieved.object==="event"&&retrieved.type===selected.type&&retrieved.account==null&&retrieved.context==null&&retrieved.livemode===selected.livemode&&retrieved.created===selected.created&&retrieved.api_version===selected.api_version&&isDeepStrictEqual(retrieved.request,selected.request)&&isDeepStrictEqual(retrieved.data,selected.data));
 await teamRpc(c.admin,"record_sales_team_saved_confirmation_event_v1",{p_operation_id:operationId,p_proof:{context:c.context,operationId,obligationId:source.automatic.obligation_id,paymentIntentId:intentId,idempotencyKey:operation.data.idempotency_key,eventId:selected.id,eventType:selected.type,eventStatus:(selected.data.object as Stripe.PaymentIntent).status,eventCreated:selected.created,eventApiVersion:selected.api_version,eventAccount:null,eventLivemode:selected.livemode,originalRequestId:origin,eventRetrieveRequestId:requestId(retrieved),listRequestIds:[...requests],readStartedAt:started,observedAt:Math.floor(Date.now()/1000)}});
 return origin!;
}
export async function confirmSavedTeamCollection(c:TeamReceiptComposition,saleId:string,buyerId:string,input:{obligationId:string;requestId:string;onSession:boolean;recoveryOnly?:boolean;worker?:Worker;admitNew?:boolean}){
 let source=await readTeamAutomaticCollection(c,saleId,buyerId,input.obligationId),s=source.payment;check(s.attempt);assertTeamSavedAuthority(s.attempt.contract,source.authority);
 const prior=await c.admin.from("sales_team_payment_confirmations_v1").select("*").eq("obligation_id",input.obligationId).eq("request_id",teamId(input.requestId)).maybeSingle();if(prior.error)throw prior.error;
 let saved=prior.data as Confirmation|null;
 const scope:TeamOperationScope={scopeId:saleId,saleId,creatorId:s.sale.creator_id,actorId:buyerId,kind:"confirmation",scopeKey:`confirm:${input.requestId}`,workerRunId:input.onSession?null:source.automatic.worker_run_id},operationId=teamOperationId(scope);
 if(input.recoveryOnly){const op=await c.admin.from("sales_team_provider_operations_v1").select("id").eq("id",operationId).maybeSingle();if(op.error)throw op.error;check(saved&&op.data);}
 const intent=await c.admin.from("sales_team_provider_operations_v1").select("provider_id,status").eq("id",s.attempt.intent_operation_id).maybeSingle();if(intent.error)throw intent.error;check(intent.data?.status==="bound"&&/^pi_[A-Za-z0-9]+$/.test(intent.data.provider_id??""));const intentId=intent.data.provider_id as string;
 if(!saved){
  check(!input.recoveryOnly&&(input.onSession?teamLaterCollectionReady()&&teamSavedMethodReady():input.admitNew===true&&teamAutomaticCollectionReady()&&input.worker));
  const pi=await readTeamOriginalIntent(c,s,intentId);await observeTeamCollectionState(c,s,pi);source=await readTeamAutomaticCollection(c,saleId,buyerId,input.obligationId);s=source.payment;
  if(input.onSession)await recordMethod(c,source,input.requestId);
  const request=teamSavedConfirmationRequest(s.attempt!.contract,source.authority,intentId,input.onSession,input.onSession&&s.state?.status==="requires_payment_method"&&s.state.proof.authenticationRequired===true);
  saved=await teamRpc<Confirmation>(c.admin,"reserve_sales_team_saved_confirmation_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_obligation_id:input.obligationId,p_request_id:input.requestId,p_operation_id:operationId,p_check_id:input.onSession?input.requestId:input.worker!.task.id,p_on_session:input.onSession,p_request:request});
 }
 check(saved&&saved.operation_id===operationId&&saved.kind===(input.onSession?"saved_reconfirm":"saved_method")&&saved.saved_method_consent_id===source.authority.consentId&&isDeepStrictEqual(saved.request,teamSavedConfirmationRequest(s.attempt!.contract,source.authority,intentId,input.onSession,saved.request.params.payment_method!==undefined&&input.onSession)));
 const request=saved.request,checkedContract=s.attempt!.contract,evidence=await c.observeEvidence();
 const retrieve=async()=>{const pi=await readTeamOriginalIntent(c,s,intentId);return {id:pi.id,requestId:requestId(pi),pi};};
 const result=await runTeamProviderOperation({admin:c.admin,scope,context:c.context,observeContext:c.observeContext,request,
  assertSource:async()=>{check(input.onSession?teamLaterCollectionReady()&&teamSavedMethodReady():input.admitNew===true&&teamAutomaticCollectionReady());await checkedMethod(c,source);const pi=await readTeamOriginalIntent(c,s,intentId);check(input.onSession?request.params.payment_method!==undefined?isTeamSavedAuthenticationRequired(pi,source.authority):pi.status==="requires_confirmation":pi.status==="requires_payment_method");},
  create:async(r,o)=>{const pi=await c.stripe.rawRequest(r.method,r.path,r.params,o) as unknown as Stripe.PaymentIntent;return {id:pi.id,requestId:requestId(pi),pi};},retrieve,
  reconcileUnknown:async()=>{const origin=await originalConfirmationEvent(c,source,operationId,intentId);if(!origin)return null;const observed=await retrieve();return {...observed,requestId:origin};},
  validate:value=>{inspectTeamPaymentIntent(checkedContract,evidence,value.pi,intentId);check(value.id===intentId&&(!value.pi.payment_method||objectId(value.pi.payment_method)===source.authority.paymentMethodId));}});
 check(result.status==="bound");s=await readTeamCollection(c,saleId,buyerId,input.obligationId);await observeTeamCollectionState(c,s,result.object.pi);return teamCollectionView(await readTeamCollection(c,saleId,buyerId,input.obligationId),result.object.pi);
}
export async function advanceTeamAutomaticCollection(c:TeamReceiptComposition,worker:Worker,saleId:string,buyerId:string,admitNew:boolean){
 let source=await readTeamAutomaticCollection(c,saleId,buyerId,worker.task.obligation_id);if(source.payment.receipt)return teamCollectionView(source.payment);
 if(source.payment.manual_collection_handoff)return (await prepareTeamCollection(c,saleId,buyerId,false,worker.task.obligation_id)).view;
 let methodChecked=false;
 const operation=source.payment.attempt?await c.admin.from("sales_team_provider_operations_v1").select("id").eq("id",source.payment.attempt.intent_operation_id).maybeSingle():null;if(operation?.error)throw operation.error;
 if(admitNew&&!operation?.data&&worker.canDispatch?.()!==false){check(teamAutomaticCollectionReady());await recordMethod(c,source,worker.task.id,worker);methodChecked=true;}
 const prepared=await prepareTeamCollection(c,saleId,buyerId,admitNew&&worker.canDispatch?.()!==false,worker.task.obligation_id);source=await readTeamAutomaticCollection(c,saleId,buyerId,worker.task.obligation_id);
 if(!source.payment.attempt||prepared.view.phase==="paid")return prepared.view;
 const confirmation=source.payment.confirmation;
 if(confirmation&&confirmation.kind!=="saved_method")return prepared.view;
 if(!confirmation&&!admitNew)return prepared.view;
 const confirmationOperation=confirmation?await c.admin.from("sales_team_provider_operations_v1").select("id").eq("id",confirmation.operation_id).maybeSingle():null;if(confirmationOperation?.error)throw confirmationOperation.error;
 if(!confirmationOperation?.data){if(!admitNew||worker.canDispatch?.()===false)return prepared.view;if(!methodChecked)await recordMethod(c,source,worker.task.id,worker);}
 return confirmSavedTeamCollection(c,saleId,buyerId,{obligationId:worker.task.obligation_id,requestId:source.automatic.request_id,onSession:false,worker,admitNew,recoveryOnly:!admitNew});
}
export async function prepareTeamManualCollection(c:TeamReceiptComposition,saleId:string,buyerId:string,obligationId:string){
 const original=await prepareTeamCollection(c,saleId,buyerId,false,obligationId);if(original.saved.receipt)return original;
 await teamRpc(c.admin,"request_sales_team_manual_collection_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),p_obligation_id:teamId(obligationId)});
 return prepareTeamCollection(c,saleId,buyerId,true,obligationId);
}
