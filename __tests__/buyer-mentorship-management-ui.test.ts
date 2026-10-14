/** @jest-environment jsdom */
import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {MentorshipPaymentManagement} from "../app/payments/mentorship/[requestId]/MentorshipPaymentManagement";
import type {BuyerMentorshipManagementView} from "../lib/mentorshipInstallmentManagement";
import {completeContextBankVerification} from "../lib/installments/bankVerificationClient";
jest.mock("../lib/installments/bankVerificationClient",()=>({completeContextBankVerification:jest.fn(async()=>undefined)}));
const sdk=jest.mocked(completeContextBankVerification),fetchMock=jest.fn();
const initial:BuyerMentorshipManagementView={requestId:"10000000-0000-4000-8000-000000000001",title:"Mentorship",mode:"test",totalCents:10001,
  paymentCount:3,serviceMonths:10,serviceEndsAt:null,financialReview:false,debitStopped:false,payments:[{paymentNumber:2,amountCents:3333,dueAt:1789920000,
    invoiceId:"in_original",outcome:"action_required",canVerifyBank:true,canCheck:true}]};
let root:Root,container:HTMLDivElement;
beforeEach(async()=>{
  localStorage.clear();
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;fetchMock.mockReset();sdk.mockReset();sdk.mockResolvedValue(undefined);global.fetch=fetchMock;
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial})));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
const button=(text:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent===text)!;
const click=async(text:string)=>act(async()=>button(text).click());
const accept=async()=>act(async()=>container.querySelector<HTMLInputElement>("input")!.click());
test("mount and refresh never authenticate or send payment",async()=>{
  expect(fetchMock).not.toHaveBeenCalled();expect(sdk).not.toHaveBeenCalled();expect(button("Verify with my bank").disabled).toBe(true);
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({view:initial})});await click("Refresh records");
  expect(fetchMock.mock.calls[0][1].method).toBeUndefined();expect(sdk).not.toHaveBeenCalled();
});
test("explicit consent invokes existing SDK for original payment then verifies server receipt",async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_verification_ready",amountCents:3333,paymentNumber:2,publishableKey:"pk_test_synthetic",clientSecret:"pi_original_secret_synthetic"})});
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_recovery_recorded",outcome:"paid_accounted"})});
  await accept();await click("Verify with my bank");
  expect(sdk).toHaveBeenCalledWith("pk_test_synthetic","pi_original_secret_synthetic","test");
  expect(fetchMock.mock.calls.map(([,o])=>JSON.parse(o.body))).toEqual([{action:"bank_verification",invoiceId:"in_original"},{action:"check_payment",invoiceId:"in_original"}]);
  expect(container.textContent).toContain("verified and recorded");expect(container.innerHTML).not.toContain("secret_synthetic");
  expect(container.textContent).toContain("10 months");
});
test("SDK completion cannot substitute for missing server receipt",async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_verification_ready",amountCents:3333,paymentNumber:2,publishableKey:"pk_test_synthetic",clientSecret:"pi_original_secret_synthetic"})});
  fetchMock.mockRejectedValueOnce(Error("lost receipt"));await accept();await click("Verify with my bank");
  expect(container.textContent).toContain("not confirmed");expect(button("Verify with my bank").disabled).toBe(true);
});
test("mismatched payment challenge never reaches SDK",async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_verification_ready",amountCents:1,paymentNumber:2})});
  await accept();await click("Verify with my bank");expect(sdk).not.toHaveBeenCalled();expect(container.textContent).toContain("not confirmed");
});
test("repeated clicks while bank verification is open cannot start another action",async()=>{
  let finish!:()=>void;
  sdk.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_verification_ready",amountCents:3333,paymentNumber:2,publishableKey:"pk_test_synthetic",clientSecret:"pi_original_secret_synthetic"})});
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_recovery_recorded",outcome:"payment_pending"})});
  await accept();await click("Verify with my bank");
  await click("Verify with my bank");await click("Check payment receipt");await click("Refresh records");
  expect(fetchMock).toHaveBeenCalledTimes(1);expect(sdk).toHaveBeenCalledTimes(1);
  await act(async()=>finish());
  expect(fetchMock).toHaveBeenCalledTimes(2);expect(button("Verify with my bank")).toBeUndefined();
});
test.each([false,true])("debit stop preserves pending payment disclosure: %s",async pending=>{
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:{...initial,canStopDebit:true},key:"stop"})));
  expect(button("Stop new automatic payments").disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({requestId:initial.requestId,status:pending?"admitted_payment_pending":"new_debits_stopped",pendingPayments:pending?1:0,revokedAt:"2026-09-21T00:00:00Z"})});
  await act(async()=>container.querySelector<HTMLInputElement>('section[aria-label="Stop automatic payments"] input')!.click());
  await click("Stop new automatic payments");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({action:"revoke_debit"});
  expect(sdk).not.toHaveBeenCalled();expect(button("Verify with my bank")).toBeUndefined();
  expect(container.textContent).toContain("Your agreed unpaid balance remains due");
  if(pending)expect(container.textContent).toContain("already in progress still needs confirmation");
});
test("lost debit stop response cannot claim automatic payments stopped",async()=>{
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:{...initial,canStopDebit:true},key:"stop"})));
  fetchMock.mockRejectedValueOnce(Error("lost response"));
  await act(async()=>container.querySelector<HTMLInputElement>('section[aria-label="Stop automatic payments"] input')!.click());
  await click("Stop new automatic payments");
  expect(container.textContent).toContain("stop request is not confirmed");
  expect(container.textContent).not.toContain("New automatic payments are stopped");
  expect(button("Verify with my bank").disabled).toBe(true);
});
test("lost setup response retries the persisted request ID with explicit consent",async()=>{
  const setupId="10000000-0000-4000-8000-000000000099",key=`creatornet:mentorship-card:${initial.requestId}:in_original`;
  localStorage.setItem(key,setupId);
  const cardView={...initial,payments:[{...initial.payments[0],outcome:"payment_method_required",canVerifyBank:false,canStartCard:true}]};
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:cardView,key:"card"})));
  expect(fetchMock).not.toHaveBeenCalled();expect(button("Prepare secure card setup").disabled).toBe(true);
  fetchMock.mockImplementationOnce(async()=>{expect(localStorage.getItem(key)).toBe(setupId);throw Error("lost response");});
  await accept();await click("Prepare secure card setup");
  expect(container.textContent).toContain("Card setup is not confirmed");
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"prepared_unpublished",setupId})});
  await accept();await click("Prepare secure card setup");
  expect(fetchMock.mock.calls.map(([,o])=>JSON.parse(o.body))).toEqual([1,2].map(()=>({action:"prepare_card",invoiceId:"in_original",setupId,
    consent:{accepted:true,consentVersion:"replacement-card-setup-v1"}})));
  expect(sdk).not.toHaveBeenCalled();expect(container.textContent).toContain("original card setup is ready");
});
test("saved-card check uses the server-recovered request and never attempts payment",async()=>{
  const setupId="10000000-0000-4000-8000-000000000099";
  const cardView={...initial,payments:[{...initial.payments[0],outcome:"payment_method_required",canVerifyBank:false,
    cardSetup:{requestId:setupId,state:"prepared" as const,canPrepare:false,canOpen:false,canVerify:true}}]};
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:cardView,key:"card"})));
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"card_saved_payment_not_attempted",setupId})});
  await click("Check saved card");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({action:"verify_card",invoiceId:"in_original",setupId});
  expect(container.textContent).toContain("No payment was attempted");expect(sdk).not.toHaveBeenCalled();
});

const quoteId="10000000-0000-4000-8000-000000000088",setupId="10000000-0000-4000-8000-000000000099";
function retryView(withQuote=true):BuyerMentorshipManagementView {
  return {...initial,payments:[{...initial.payments[0],outcome:"payment_method_required",canVerifyBank:false,
    cardSetup:{requestId:setupId,state:"verified",canPrepare:false,canOpen:false,canVerify:false},
    retry:{admitted:false,canReview:true,canPay:withQuote,canUseFutureCard:false,quote:withQuote?{id:quoteId,amountCents:3333,paymentNumber:2,paymentCount:3,
      confirmed:false,consentVersion:"single-invoice-pay-now-v1",expiresAt:Math.floor(Date.now()/1000)+200}:null}}]};
}
async function renderRetry(view=retryView()) {await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:view,key:"retry"})));}
test("replacement payment requires explicit amount consent and records attempt before POST",async()=>{
  await renderRetry();const pay="Pay $33.33 with saved replacement card";
  expect(fetchMock).not.toHaveBeenCalled();expect(button(pay).disabled).toBe(true);
  fetchMock.mockImplementationOnce(async()=>{
    expect(localStorage.getItem(`creatornet:mentorship-quote:${initial.requestId}:in_original:attempted`)).toBe(quoteId);
    return {ok:true,json:async()=>({status:"payment_recovery_recorded",outcome:"action_required"})};
  });
  await accept();await click(pay);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({action:"pay_retry",invoiceId:"in_original",setupId,quoteId,
    consent:{accepted:true,consentVersion:"single-invoice-pay-now-v1"}});
  expect(sdk).not.toHaveBeenCalled();expect(container.textContent).toContain("needs follow-up");
});
test("lost payment response remains disabled after a refresh and cannot dispatch twice",async()=>{
  await renderRetry();fetchMock.mockRejectedValueOnce(Error("lost response"));await accept();await click("Pay $33.33 with saved replacement card");
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({view:retryView()})});await click("Refresh records");await accept();
  expect(button("Pay $33.33 with saved replacement card").disabled).toBe(true);
  await click("Pay $33.33 with saved replacement card");expect(fetchMock).toHaveBeenCalledTimes(2);
});
test("lost review response reuses its saved quote ID without sending a payment",async()=>{
  const key=`creatornet:mentorship-quote:${initial.requestId}:in_original`;localStorage.setItem(key,quoteId);
  await renderRetry(retryView(false));fetchMock.mockRejectedValueOnce(Error("lost review"));await click("Review replacement-card payment");
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_review",quote:retryView().payments[0].retry!.quote})});
  await click("Review replacement-card payment");
  expect(fetchMock.mock.calls.map(([,o])=>JSON.parse(o.body))).toEqual([1,2].map(()=>({action:"review_retry",invoiceId:"in_original",setupId,quoteId,futureCardOption:false})));
  expect(button("Pay $33.33 with saved replacement card").disabled).toBe(true);
});
test("an admitted retry never displays another payment button",async()=>{
  const view=retryView();view.payments[0].retry!.admitted=true;view.payments[0].retry!.canPay=false;
  await renderRetry(view);expect(button("Pay $33.33 with saved replacement card")).toBeUndefined();expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("No payment authorized");
});
test("saved local uncertainty survives remount",async()=>{
  localStorage.setItem(`creatornet:mentorship-quote:${initial.requestId}:in_original:attempted`,quoteId);
  await renderRetry();await accept();expect(button("Pay $33.33 with saved replacement card").disabled).toBe(true);expect(fetchMock).not.toHaveBeenCalled();
});


function futureView(withQuote=true) {
  const view=retryView(withQuote),dueAt=Math.floor(Date.now()/1000)+86400;
  view.payments.push({paymentNumber:3,amountCents:3335,dueAt,invoiceId:null,outcome:"scheduled",canVerifyBank:false,canCheck:false});
  view.payments[0].retry!.canUseFutureCard=true;
  if(withQuote)view.payments[0].retry!.quote={...view.payments[0].retry!.quote!,remainingPayments:[{paymentNumber:3,amountCents:3335,dueAt,periodEnd:dueAt+28*86400}]};
  return view;
}
test.each([false,true])("future card use requires separate optional consent: %s",async future=>{
  await renderRetry(futureView());
  const inputs=container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(inputs).toHaveLength(2);expect(inputs[0].checked).toBe(false);expect(inputs[1].checked).toBe(false);
  expect(container.querySelector('[aria-label="Remaining scheduled payments"]')!.textContent).toContain("$33.35");
  await act(async()=>inputs[0].click());if(future)await act(async()=>inputs[1].click());
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_recovery_recorded",outcome:"paid_accounted",futureCollection:future?"collection_resumed":"not_requested"})});
  await click("Pay $33.33 with saved replacement card");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).consent).toEqual({accepted:true,consentVersion:"single-invoice-pay-now-v1",
    ...(future?{futureCardConsentVersion:"same-plan-remaining-card-v1"}:{})});
  expect(container.textContent).toContain(future?"Future installments will use your replacement card":"Future automatic collection remains under review");
});
test("future review option survives lost response and remount without changed parameters",async()=>{
  const key=`creatornet:mentorship-quote:${initial.requestId}:in_original`;
  localStorage.setItem(`${key}:request`,JSON.stringify({quoteId,futureCardOption:true}));
  await renderRetry(futureView(false));fetchMock.mockRejectedValueOnce(Error("lost review"));await click("Review replacement-card payment");
  const next=futureView(false);next.payments[0].retry!.canUseFutureCard=false;
  await act(async()=>root.render(React.createElement(MentorshipPaymentManagement,{initial:next,key:"remount-future"})));
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_review",quote:futureView().payments[0].retry!.quote})});
  await click("Review replacement-card payment");
  expect(fetchMock.mock.calls.map(([,o])=>JSON.parse(o.body))).toEqual([1,2].map(()=>({action:"review_retry",invoiceId:"in_original",setupId,quoteId,futureCardOption:true})));
  expect(button("Pay $33.33 with saved replacement card").disabled).toBe(true);
});
test("changed future schedule cannot become a payable review",async()=>{
  const key=`creatornet:mentorship-quote:${initial.requestId}:in_original`;
  localStorage.setItem(`${key}:request`,JSON.stringify({quoteId,futureCardOption:true}));
  await renderRetry(futureView(false));const quote=futureView().payments[0].retry!.quote!;
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"payment_review",quote:{...quote,remainingPayments:[{...quote.remainingPayments![0],amountCents:1}]}})});
  await click("Review replacement-card payment");expect(container.textContent).toContain("review is not confirmed");
  expect(button("Pay $33.33 with saved replacement card")).toBeUndefined();
});
test("refresh clears both payment and future consent",async()=>{
  await renderRetry(futureView());await act(async()=>container.querySelectorAll<HTMLInputElement>('input').forEach(input=>input.click()));
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({view:futureView()})});await click("Refresh records");
  expect([...container.querySelectorAll<HTMLInputElement>('input')].every(input=>!input.checked)).toBe(true);
});


test("new future review persists its exact options before sending",async()=>{
  const uuid=jest.spyOn(crypto,"randomUUID").mockReturnValue(quoteId);
  try {
    const view=futureView(false);await renderRetry(view);
    const key=`creatornet:mentorship-quote:${initial.requestId}:in_original`;
    fetchMock.mockImplementationOnce(async(_url,options)=>{
      expect(JSON.parse(localStorage.getItem(`${key}:request`)!)).toEqual({quoteId,futureCardOption:true});
      expect(JSON.parse(options.body).futureCardOption).toBe(true);
      return {ok:true,json:async()=>({status:"payment_review",quote:futureView().payments[0].retry!.quote})};
    });
    await click("Review replacement-card payment");
    expect(container.textContent).toContain("Review the amount and consent");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    await act(async()=>container.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(button("Pay $33.33 with saved replacement card").disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {uuid.mockRestore();}
});
