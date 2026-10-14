import "server-only";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {readBuyerMentorshipAdmittedPayment} from "./mentorshipInstallmentReconciliation";
import {verifyBuyerMentorshipContinuationProvider} from "./mentorshipInstallmentContinuationProvider";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer future card requires review");}

type Args={buyerId:string;requestId:string;invoiceId:string;quoteId:string;env?:Record<string,string|undefined>};
/** Internal receipt-backed authorization; provider and DB collection stay held. */
export const authorizeBuyerMentorshipFutureCard=(args:Args)=>runFutureCard(args,false);
/** Separately gated resume, with original release recovery after a lost reply. */
export const resumeBuyerMentorshipFutureCollection=(args:Args)=>runFutureCard(args,true);
async function runFutureCard(args:Args,resume:boolean) {
  try {
    const env=args.env??process.env;
    check(["FUTURE_CARD_SCHEMA_READY","RETRY_SCHEMA_READY","RETRY_RECEIPT_READY"]
      .every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
    if(resume)check(env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_RELEASE_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_RELEASE_RECOVERY_READY==="true");
    assertAgreementId(args.quoteId);
    const original=await readBuyerMentorshipAdmittedPayment(args),{r,a,defaultPaymentMethodId,admin,runtime,context}=original;
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_quote_id:args.quoteId};
    const release=async(basis:unknown)=>{
      validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
      const done=await admin.rpc("release_buyer_mentorship_future_collection_v1",{...scope,p_basis:basis});
      check(!done.error && done.data?.status==="collection_resumed" && done.data.reservationId===r.id && done.data.quoteId===args.quoteId);
      return {status:"collection_resumed" as const};
    };
    if(resume) {
      const previous=await admin.from("buyer_mentorship_collection_releases_v1").select("quote_id,reservation_id,verified_basis")
        .eq("quote_id",args.quoteId).eq("reservation_id",r.id).maybeSingle();
      check(!previous.error);
      if(previous.data) {
        check(previous.data.quote_id===args.quoteId && previous.data.reservation_id===r.id &&
          previous.data.verified_basis?.afterPaymentNumber===a.paymentNumber);
        // Replay only this saved release; SQL refuses a newer hold or stop.
        return await release(previous.data.verified_basis);
      }
      check(["COLLECTION_RELEASE_READY","FUTURE_COLLECTION_READY","INVOICE_CARD_SCHEMA_READY","CARD_RECOVERY_SCHEMA_READY"]
        .every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
    }
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY==="true");
    const read=async()=>{
      const result=await admin.rpc("read_buyer_mentorship_future_card_context_v1",scope);
      check(!result.error && result.data?.reservationId===r.id && result.data.quoteId===args.quoteId &&
        result.data.afterPaymentNumber===a.paymentNumber && result.data.originalDefaultPaymentMethodId===defaultPaymentMethodId &&
        /^pm_[A-Za-z0-9]+$/.test(result.data.paymentMethodId) && Array.isArray(result.data.prior));
      return result.data;
    };
    const basis=await read();
    const sub=await verifyBuyerMentorshipContinuationProvider(args,original,basis);
    await sub();validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    check(isDeepStrictEqual(await read(),basis));
    const saved=await admin.rpc("authorize_buyer_mentorship_future_card_v1",{...scope,p_basis:basis});
    check(!saved.error && saved.data?.status==="authorized_held" && saved.data.reservationId===r.id && saved.data.quoteId===args.quoteId);
    if(resume) {
      await sub();check(isDeepStrictEqual(await read(),basis));
      return await release(basis);
    }
    return {status:"authorized_held" as const};
  } catch {throw Error("Buyer future card requires review");}
}
