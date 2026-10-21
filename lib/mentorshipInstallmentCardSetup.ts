import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactCardSetupParams,assertExactCardSetupSession,inspectExactCardSetupUnpaid,inspectExactSavedCard,type BuyerCardSetup} from "./installments/cardRecovery";
import {readBuyerMentorshipRecoveryAction} from "./mentorshipInstallmentPaymentRecovery";
function check(v:unknown):asserts v {if(!v)throw Error("Original buyer card setup requires review");}
type SetupArgs={buyerId:string;requestId:string;invoiceId:string;setupId:string;env?:Record<string,string|undefined>};
function parseSavedSetup(raw:unknown,original:Awaited<ReturnType<typeof readBuyerMentorshipRecoveryAction>>,setupId:string) {
  check(raw && typeof raw==="object" && !Array.isArray(raw));const s=raw as Record<string,unknown>;
  const {r,a,context,paymentMethodId,paymentIntentId}=original;
  check(s.id===setupId && s.reservation_id===r.id && s.buyer_id===r.buyerId && s.invoice_id===a.invoiceId &&
    s.original_payment_intent_id===paymentIntentId && isDeepStrictEqual(s.authorization_snapshot,{...a,paymentMethodId}) && typeof s.created_at==="string");
  const createdAt=Math.floor(Date.parse(s.created_at)/1000);
  check(Number.isSafeInteger(createdAt) && createdAt>0 && s.expires_at===createdAt+3600);
  const proof:BuyerCardSetup={id:setupId,buyerId:r.buyerId,buyerReservationId:r.id,buyerRequestId:r.requestId,invoiceId:a.invoiceId,
    originalPaymentIntentId:paymentIntentId,authorization:{...a,paymentMethodId},createdAt,expiresAt:createdAt+3600,
    sessionId:null,setupIntentId:null,paymentMethodId:null};
  const params=exactCardSetupParams(proof,context.siteOrigin);
  const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:"/v1/checkout/sessions",params};
  check(isDeepStrictEqual(s.request,request) && s.idempotency_key===`cn-buyer-card-setup-v1:${setupId}`);
  return {proof,params,request};
}

/** Internal authenticated-buyer composition. Consent is supplied only by an
 * explicit buyer action. Returns no URL, changes no default and never pays. */
export async function prepareBuyerMentorshipCardSetup(args:{buyerId:string;requestId:string;invoiceId:string;setupId:string;
  consent:unknown;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(["CARD_SETUP_SCHEMA_READY","CARD_SETUP_READY"].every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
    assertAgreementId(args.setupId);
    check(isDeepStrictEqual(args.consent,{accepted:true,consentVersion:"replacement-card-setup-v1"}));
    const original=await readBuyerMentorshipRecoveryAction(args,"payment_method_required");
    const {r,a,context,paymentMethodId,paymentIntentId,admin,stripe,contract,assertFresh}=original;
    await inspectExactCardSetupUnpaid(stripe,{invoiceId:a.invoiceId,originalPaymentIntentId:paymentIntentId,
      authorization:{...a,paymentMethodId}},contract,original.defaultPaymentMethodId);
    await assertFresh();
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_setup_id:args.setupId};
    const reserved=await admin.rpc("reserve_buyer_mentorship_card_setup_v1",{...scope,p_invoice_id:a.invoiceId,p_consent:args.consent});
    check(!reserved.error && reserved.data?.paymentAllowed===false);
    const s=reserved.data.setup;
    const {proof,params,request}=parseSavedSetup(s,original,args.setupId);
    const saved=await admin.rpc("read_buyer_mentorship_card_setup_v1",scope);
    check(!saved.error && isDeepStrictEqual(saved.data?.setup,s) && saved.data.paymentAllowed===false);
    let session;
    if(saved.data.binding) {
      check(saved.data.binding.setup_id===s.id && /^cs_[A-Za-z0-9_]+$/.test(saved.data.binding.session_id));
      const sessionId=saved.data.binding.session_id;
      session=await stripe.checkout.sessions.retrieve(sessionId);
      check(session.id===sessionId);
    } else {
      await assertFresh();
      const admitted=await admin.rpc("admit_buyer_mentorship_card_setup_v1",{...scope,p_request:request});
      check(!admitted.error && isDeepStrictEqual(admitted.data?.setup,s) && admitted.data.dispatchAllowed===true && admitted.data.paymentAllowed===false);
      const deadline=Date.parse(admitted.data.dispatchBefore),now=Date.now();
      check(Number.isFinite(deadline) && deadline>now && deadline<=now+31000);
      session=await stripe.checkout.sessions.create(params,{idempotencyKey:s.idempotency_key,maxNetworkRetries:0,timeout:Math.min(10000,deadline-now)});
    }
    assertExactCardSetupSession(session,proof,context.mode==="live");
    const bound=await admin.rpc("bind_buyer_mentorship_card_setup_v1",{...scope,p_session:session});
    check(!bound.error && isDeepStrictEqual(bound.data?.setup,s) && bound.data.binding?.session_id===session.id && bound.data.paymentAllowed===false);
    return {status:"prepared_unpublished" as const,setupId:s.id as string,sessionId:session.id};
  } catch {throw Error("Card setup is not confirmed. Keep the original request and check its status before continuing.");}
}

async function readExistingBuyerSetup(args:SetupArgs) {
  const env=args.env??process.env;
  check(["CARD_SETUP_SCHEMA_READY","CARD_SETUP_READY"].every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
  assertAgreementId(args.setupId);
  const original=await readBuyerMentorshipRecoveryAction(args,"payment_method_required");
  const {a,context,paymentMethodId,paymentIntentId,admin,stripe,contract}=original;
  await inspectExactCardSetupUnpaid(stripe,{invoiceId:a.invoiceId,originalPaymentIntentId:paymentIntentId,authorization:{...a,paymentMethodId}},contract,original.defaultPaymentMethodId);
  const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_setup_id:args.setupId};
  const saved=await admin.rpc("read_buyer_mentorship_card_setup_v1",scope);
  check(!saved.error && saved.data?.paymentAllowed===false);
  const {proof}=parseSavedSetup(saved.data.setup,original,args.setupId);
  check(saved.data.binding?.setup_id===args.setupId && typeof saved.data.binding.session_id==="string" && /^cs_[A-Za-z0-9_]+$/.test(saved.data.binding.session_id));
  return {original,scope,proof,sessionId:saved.data.binding.session_id as string};
}

/** Gated authenticated setup-only handoff; never creates a replacement link. */
export async function readBuyerMentorshipCardSetupRedirect(args:SetupArgs) {
  try {
    check((args.env??process.env).CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_PUBLISH_READY==="true");
    const {original,proof,sessionId}=await readExistingBuyerSetup(args);
    const {stripe,context,assertFresh}=original;
    const session=await stripe.checkout.sessions.retrieve(sessionId);
    assertExactCardSetupSession(session,proof,context.mode==="live");
    const returnUrl=`${context.siteOrigin}/payments/mentorship/${proof.buyerRequestId}`;
    check(session.id===sessionId && session.status==="open" && session.expires_at>Math.floor(Date.now()/1000) &&
      session.success_url===returnUrl && session.cancel_url===returnUrl && typeof session.url==="string");
    const url=new URL(session.url);
    check(url.protocol==="https:" && url.hostname==="checkout.stripe.com" && !url.username && !url.password && !url.port &&
      url.pathname.startsWith("/c/") && url.pathname.includes(sessionId));
    await assertFresh();
    return {status:"card_setup_ready" as const,setupId:args.setupId,url:session.url};
  } catch {throw Error("Secure card setup is unavailable. Check the original setup request before continuing.");}
}

/** Observes only the originally bound setup, then records proof under a fresh
 * recovery snapshot. It never creates a setup, confirms a card or retries a PI. */
export async function verifyBuyerMentorshipSavedCard(args:SetupArgs) {
  try {
    const env=args.env??process.env;
    check(["SAVED_CARD_SCHEMA_READY","SAVED_CARD_READY"].every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
    const {original,scope,proof,sessionId}=await readExistingBuyerSetup(args);
    const {context,admin,stripe,assertFresh,bound}=original;
    let setupIntent:Stripe.SetupIntent|null=null,paymentMethod:Stripe.PaymentMethod|null=null;
    const result=await inspectExactSavedCard({checkout:{sessions:{retrieve:id=>stripe.checkout.sessions.retrieve(id)}},
      setupIntents:{retrieve:async id=>{setupIntent=await stripe.setupIntents.retrieve(id);return setupIntent;}},
      paymentMethods:{retrieve:async id=>{paymentMethod=await stripe.paymentMethods.retrieve(id);return paymentMethod;}}},
      {...proof,sessionId},Math.floor(Date.now()/1000),context.mode==="live");
    await assertFresh();
    if(result.status==="setup_pending")return {status:"setup_pending" as const,setupId:args.setupId};
    check(setupIntent && paymentMethod);
    const recorded=await admin.rpc("record_buyer_mentorship_saved_card_v1",{...scope,p_basis:bound,p_session_id:sessionId,
      p_setup_intent:setupIntent,p_payment_method:paymentMethod});
    check(!recorded.error && recorded.data?.status==="card_saved_payment_not_attempted" && recorded.data.setupId===args.setupId && recorded.data.paymentAllowed===false &&
      recorded.data.proof?.session_id===sessionId && recorded.data.proof.setup_intent_id===result.setupIntentId && recorded.data.proof.payment_method_id===result.paymentMethodId && recorded.data.proof.billing_country==="US");
    return {status:"card_saved_payment_not_attempted" as const,setupId:args.setupId};
  } catch {throw Error("Saved card could not be verified. Payment remains on hold; check the original setup request.");}
}
