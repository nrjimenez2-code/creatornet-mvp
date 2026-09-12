import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {assertAgreementId} from "./agreementStore";
import {readExactContextReservation} from "./contextReservation";
import {readExactContextCustomerIntent} from "./contextBootstrap";
import {contextStripeId} from "./contextCheckout";
import {readContextInvoiceCollection} from "./contextInvoice";
import {parseExactCardSetup,inspectExactCardSetupUnpaid,exactCardSetupParams,assertExactCardSetupSession,inspectExactSavedCard,
  CARD_SETUP_CONSENT_VERSION} from "./cardRecovery";
import type {ExactPaymentContext,ExactPaymentContextEvidence} from "./paymentContext";

function check(v:unknown):asserts v {if(!v) throw Error("Context card setup requires review");}
function fields(v:unknown,keys:string[]):Record<string,unknown> {
  check(v&&typeof v==="object"&&!Array.isArray(v));const ds=Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).length===keys.length&&keys.every(k=>ds[k]&&"value" in ds[k]&&ds[k].enumerable));return v as Record<string,unknown>;
}
/** Internal buyer-owned SETUP composition. No link is published, card confirmed,
 * debit retried, default changed or hold released by this adapter. */
export async function prepareContextCardSetup(args:{reservationId:string;buyerId:string;invoiceId:string;requestId:string;
  action:"prepare"|"verify"|"publish";consent:unknown;context:ExactPaymentContext;stripe:Stripe;apiVersion:string;
  evidence():Promise<ExactPaymentContextEvidence>;fresh():void;
  rpc(name:"read_exact_context_card_setup_v2"|"run_exact_context_card_setup_v2",params:object):Promise<unknown>;
  get<T>(path:string,read:()=>Promise<T>):Promise<T>;
  create(params:Stripe.Checkout.SessionCreateParams,key:string,startedAt:number):Promise<Stripe.Checkout.Session>}) {
  const {reservationId,buyerId,invoiceId,requestId,stripe,context,get}=args;
  for(const v of [reservationId,buyerId,requestId]) assertAgreementId(v);contextStripeId(invoiceId,"in");
  if(args.action==="prepare") check(isDeepStrictEqual(args.consent,{accepted:true,consentVersion:CARD_SETUP_CONSENT_VERSION}));
  else check(args.consent===null);
  const base={p_reservation_id:reservationId,p_actor_id:buyerId,p_context:context,p_invoice_id:invoiceId,p_request_id:requestId};
  async function parse(raw:unknown) {
    const evidence=await args.evidence();args.fresh();
    const v=fields(raw,["reservation","operation","collection","dependencies","setup"]),r=readExactContextReservation(v.reservation,evidence);
    check(r.id===reservationId&&r.terms.buyerId===buyerId);
    const intent=readExactContextCustomerIntent({intentRow:v.operation,reservationRow:v.reservation,contextEvidence:evidence,actorId:r.terms.creatorId});
    check(intent.request.apiVersion===args.apiVersion);
    const d=fields(v.dependencies,["customerId","subscriptionId","productId","anchor"]);
    const deps={customerId:contextStripeId(d.customerId,"cus"),subscriptionId:contextStripeId(d.subscriptionId,"sub"),
      productId:contextStripeId(d.productId,"prod"),anchor:Number(d.anchor)};
    check(Number.isSafeInteger(d.anchor)&&deps.anchor>0);
    const collection=readContextInvoiceCollection(v.collection,r,deps,invoiceId);
    check(collection.agreementStatus==="active"&&collection.authorization&&collection.state.claim?.status==="dispatching");
    const metadata={installment_collection_version:r.terms.version,context_hash:intent.contextHash,terms_hash:intent.termsHash};
    const setup=v.setup===null?null:parseExactCardSetup(v.setup,context.mode==="live");
    let dispatch:null|{token:string;startedAt:number;key:string;params:Stripe.Checkout.SessionCreateParams}=null;
    if(setup) {
      check(setup.id===requestId&&setup.buyerId===buyerId&&setup.agreementId===reservationId&&setup.invoiceId===invoiceId&&
        setup.originalPaymentIntentId===collection.state.claim.paymentIntentId&&isDeepStrictEqual(setup.authorization,collection.authorization));
      const s=v.setup as Record<string,unknown>,now=Math.floor(Date.now()/1000);
      check(s.context_mode===context.mode&&now>=setup.createdAt&&now<setup.expiresAt&&now>=setup.authorization.periodStart&&now<setup.authorization.periodEnd);
      if(s.context_dispatch_token!==null) {
        check(typeof s.context_dispatch_token==="string");assertAgreementId(s.context_dispatch_token);
        check(typeof s.context_dispatched_at==="string");const startedAt=Date.parse(s.context_dispatched_at);
        check(Number.isFinite(startedAt)&&startedAt>=setup.createdAt*1000&&startedAt<=Date.now());
        const request=fields(s.context_request,["params","idempotencyKey"]),params=exactCardSetupParams(setup,context.siteOrigin,metadata);
        const key=`cn-exact-v2-card:${requestId}:${s.context_dispatch_token}`;
        check(request.idempotencyKey===key&&isDeepStrictEqual(request.params,params));
        dispatch={token:s.context_dispatch_token,startedAt,key,params};
      } else check(s.context_dispatched_at===null&&s.context_request===null&&setup.sessionId===null);
    }
    return {r,setup,dispatch,metadata,collection};
  }
  const read=async()=>parse(await args.rpc("read_exact_context_card_setup_v2",base));
  const phase=async(name:"reserve"|"claim"|"bind"|"verify",proof:unknown=null)=>{
    await args.evidence();args.fresh();
    const result=fields(await args.rpc("run_exact_context_card_setup_v2",{...base,p_phase:name,p_proof:proof}),["dispatched","state"]);
    check(typeof result.dispatched==="boolean");return {dispatched:result.dispatched,state:await parse(result.state)};
  };
  let state=await read();
  if(args.action==="prepare") state=(await phase("reserve",args.consent)).state;
  check(state.setup);const original=state.setup;
  const unpaid=async()=>{
    const fresh=await read();check(fresh.setup&&isDeepStrictEqual(fresh.setup.authorization,original.authorization)&&fresh.setup.originalPaymentIntentId===original.originalPaymentIntentId);
    await inspectExactCardSetupUnpaid({invoices:{retrieve:id=>{check(id===invoiceId);return get(`/v1/invoices/${id}`,()=>stripe.invoices.retrieve(id));}},
      invoicePayments:{list:p=>{check(isDeepStrictEqual(p,{invoice:invoiceId,limit:100}));return get(`/v1/invoice_payments?invoice=${invoiceId}&limit=100`,()=>stripe.invoicePayments.list(p));}},
      paymentIntents:{retrieve:id=>{check(id===original.originalPaymentIntentId);return get(`/v1/payment_intents/${id}`,()=>stripe.paymentIntents.retrieve(id));}},
      subscriptions:{retrieve:id=>{check(id===original.authorization.subscriptionId);return get(`/v1/subscriptions/${id}`,()=>stripe.subscriptions.retrieve(id));}}},
      fresh.setup,{expectedLiveMode:context.mode==="live",collectionVersion:fresh.r.terms.version,
        metadata:{context_hash:fresh.metadata.context_hash,terms_hash:fresh.metadata.terms_hash}});
    args.fresh();return fresh;
  };
  const result=(status:"prepared_unpublished"|"setup_pending"|"card_saved_payment_not_attempted"|"reconciliation_required")=>Object.freeze({
    version:"exact-context-card-setup-result-v1" as const,reservationId,requestId,invoiceId,status,paymentAttempted:false as const,publicationAllowed:false as const});
  state=await unpaid();
  if(args.action==="publish") {
    check(state.setup?.sessionId&&state.dispatch);
    const sid=state.setup.sessionId,session=await get(`/v1/checkout/sessions/${sid}`,()=>stripe.checkout.sessions.retrieve(sid));
    assertExactCardSetupSession(session,original,context.mode==="live",state.metadata);
    check(session.id===sid&&session.status==="open"&&session.success_url===state.dispatch.params.success_url&&
      session.cancel_url===state.dispatch.params.cancel_url&&typeof session.url==="string"&&session.url.length<=8192&&
      !/\s/.test(session.url)&&session.expires_at>Math.floor(Date.now()/1000)+60);
    const url=new URL(session.url);
    check(url.protocol==="https:"&&url.hostname==="checkout.stripe.com"&&!url.port&&!url.username&&!url.password&&
      url.pathname.startsWith("/c/")&&url.pathname.endsWith(`/${sid}`));
    await unpaid();await args.evidence();args.fresh();
    return Object.freeze({status:"card_setup_ready" as const,url:session.url,paymentAttempted:false as const});
  }
  if(args.action==="prepare") {
    if(!state.setup!.sessionId) {
      const claimed=await phase("claim");state=claimed.state;
      if(!claimed.dispatched) return result("reconciliation_required");
      check(state.dispatch);await unpaid();await args.evidence();args.fresh();
      const session=await args.create(state.dispatch.params,state.dispatch.key,state.dispatch.startedAt);
      assertExactCardSetupSession(session,original,context.mode==="live",state.metadata);
      check(["open","complete"].includes(String(session.status))&&session.success_url===state.dispatch.params.success_url&&session.cancel_url===state.dispatch.params.cancel_url);
      await phase("bind",{token:state.dispatch.token,sessionId:session.id});
    } else {
      const sid=state.setup!.sessionId!,session=await get(`/v1/checkout/sessions/${sid}`,()=>stripe.checkout.sessions.retrieve(sid));
      assertExactCardSetupSession(session,original,context.mode==="live",state.metadata);
      check(state.dispatch&&session.id===sid&&["open","complete"].includes(String(session.status))&&
        session.success_url===state.dispatch.params.success_url&&session.cancel_url===state.dispatch.params.cancel_url);
    }
    return result("prepared_unpublished");
  }
  check(state.setup?.sessionId&&state.dispatch);let setupId:string|null=null,cardId:string|null=null;
  const proof=await inspectExactSavedCard({checkout:{sessions:{retrieve:async id=>{
    check(id===state.setup!.sessionId);const s=await get(`/v1/checkout/sessions/${id}`,()=>stripe.checkout.sessions.retrieve(id));
    check(s.success_url===state.dispatch!.params.success_url&&s.cancel_url===state.dispatch!.params.cancel_url);
    setupId=s.setup_intent==null?null:contextStripeId(s.setup_intent,"seti");return s;}}},
    setupIntents:{retrieve:async id=>{check(id===setupId);const s=await get(`/v1/setup_intents/${id}`,()=>stripe.setupIntents.retrieve(id));
      cardId=s.payment_method==null?null:contextStripeId(s.payment_method,"pm");return s;}},
    paymentMethods:{retrieve:id=>{check(id===cardId);return get(`/v1/payment_methods/${id}`,()=>stripe.paymentMethods.retrieve(id));}}},
    state.setup,Math.floor(Date.now()/1000),context.mode==="live",state.metadata);
  if(proof.status==="setup_pending") return result("setup_pending");
  await unpaid();
  await phase("verify",{token:state.dispatch.token,sessionId:state.setup.sessionId,setupIntentId:proof.setupIntentId,paymentMethodId:proof.paymentMethodId});
  return result("card_saved_payment_not_attempted");
}
