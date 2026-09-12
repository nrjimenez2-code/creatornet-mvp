/** @jest-environment jsdom */
import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {PaymentRecovery} from "../app/payments/recovery/[agreementId]/PaymentRecovery";
import type {BuyerRecoveryView} from "../lib/installments/buyerRecoveryView";
import {completeBankVerification} from "../lib/installments/bankVerificationClient";
jest.mock("../lib/installments/bankVerificationClient",()=>({completeBankVerification:jest.fn(async()=>undefined)}));
const bankMock=jest.mocked(completeBankVerification);
jest.mock("next/link",()=>({__esModule:true,default:({href,children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=>React.createElement("a",{href,...props},children)}));
const initial:BuyerRecoveryView={agreementId:"77777777-7777-4777-8777-777777777777",title:"Synthetic mentorship",totalCents:199900,
  paymentCount:3,paymentNumber:2,amountCents:66633,outcome:"payment_method_required",observedAt:null,
  setupRequestId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",setupState:"verified",setupEligible:true,
  confirmedQuoteId:null,canSaveCard:false,canConfirmPayment:true};
let container:HTMLDivElement,root:Root;const fetchMock=jest.fn();
beforeEach(async()=>{
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  global.fetch=fetchMock;fetchMock.mockReset();container=document.createElement("div");document.body.append(container);root=createRoot(container);
  bankMock.mockReset();bankMock.mockResolvedValue(undefined);
  await act(async()=>root.render(React.createElement(PaymentRecovery,{initial})));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
const button=(text:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent===text)!;
const click=async(text:string)=>act(async()=>button(text).click());
async function render(v:Partial<BuyerRecoveryView>){await act(async()=>root.render(React.createElement(PaymentRecovery,{key:JSON.stringify(v),initial:{...initial,...v}})));}
function reviewResponse(expired=false){fetchMock.mockImplementationOnce(async(_url:string,options:RequestInit)=>({ok:true,json:async()=>({status:"payment_review_ready",
  quote:{id:JSON.parse(options.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+(expired?-1:300),confirmed:false}})}));}

const futurePeriods=[{paymentNumber:3,amountCents:66634,dueAt:1900000000,periodEnd:1902600000}];
function futureReview(){fetchMock.mockImplementationOnce(async(_url:string,options:RequestInit)=>({ok:true,json:async()=>({status:"payment_review_ready",
  quote:{id:JSON.parse(options.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,
    confirmed:false,consentVersion:"single-invoice-pay-now-v1",remainingPayments:futurePeriods}})}));}
test.each([true,false])("future checkbox starts unchecked and is optional for Pay; selected=%s",async(accepted)=>{
  await render({canAttemptPayment:true});futureReview();await click("Review installment amount");
  const boxes=container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');expect(boxes).toHaveLength(2);
  expect(boxes[0].checked).toBe(false);expect(boxes[1].checked).toBe(false);
  expect(container.textContent).toContain("$666.34");expect(container.textContent).toContain("remaining balance is not waived");
  if(accepted){await act(async()=>boxes[1].click());expect(button("Pay $666.33").disabled).toBe(true);}
  await act(async()=>boxes[0].click());expect(button("Pay $666.33").disabled).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockImplementationOnce(async(_url:string,options:RequestInit)=>({ok:true,json:async()=>({status:"payment_attempt_checked",outcome:"paid_accounted",
    quote:{id:JSON.parse(options.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,
      confirmed:true,consentVersion:"single-invoice-pay-now-v1",remainingPayments:futurePeriods,futureCardAccepted:accepted}})}));
  await click("Pay $666.33");const payload=JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(payload.action).toBe("pay_now");expect(payload.futureCardConsentVersion).toBe(accepted?"same-plan-remaining-card-v1":undefined);
  expect(payload).not.toHaveProperty("amountCents");expect(payload).not.toHaveProperty("remainingPayments");
  expect(container.textContent).toContain("payment has been verified and recorded");expect(button("Pay $666.33")).toBeUndefined();
});
test("a new future review and read-only refresh never retain a checked consent",async()=>{
  await render({canAttemptPayment:true});futureReview();await click("Review installment amount");
  await act(async()=>container.querySelectorAll<HTMLInputElement>("input")[1].click());
  futureReview();await click("Review installment amount");expect(container.querySelectorAll<HTMLInputElement>("input")[1].checked).toBe(false);
  await act(async()=>container.querySelectorAll<HTMLInputElement>("input")[1].click());
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({view:{...initial,canAttemptPayment:true}})});await click("Refresh records");
  expect(container.querySelectorAll("input")).toHaveLength(0);futureReview();await click("Review installment amount");
  expect(container.querySelectorAll<HTMLInputElement>("input")[1].checked).toBe(false);
});
test("future consent survives refresh as a record, not as a claim of a successful payment or permission for other plans",async()=>{
  await render({confirmedQuoteId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",futureCardAccepted:true,canConfirmPayment:false});
  expect(container.textContent).toContain("separate card authorization is recorded");
  expect(container.textContent).toContain("requires this payment to be verified");
  expect(container.textContent).not.toContain("payment has been verified and recorded");expect(fetchMock).not.toHaveBeenCalled();
});
test("mount is read-only and uses the existing dark customer styling",()=>{
  expect(fetchMock).not.toHaveBeenCalled();expect(container.querySelector("main")?.className).toContain("bg-black");
  expect(container.textContent).toContain("$666.33");expect(container.textContent).toContain("$1,999.00");
  expect(container.textContent).toContain("Saving it did not make a payment");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
});

const bankView={outcome:"action_required",canVerifyBank:true,canCheckBankPayment:true,canConfirmPayment:false,setupEligible:false};
const challenge={status:"bank_verification_ready",amountCents:66633,paymentNumber:2,publishableKey:"pk_test_SYNTHETIC",
  clientSecret:"pi_synthetic_secret_SYNTHETIC"};
test("bank screen requires a click and checkbox; only a server-verified receipt is described as paid",async()=>{
  await render(bankView);expect(bankMock).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();
  expect(button("Verify $666.33 with bank").disabled).toBe(true);
  await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>challenge}).mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_payment_checked",outcome:"paid_accounted"})});
  await click("Verify $666.33 with bank");
  expect(fetchMock.mock.calls.map(c=>JSON.parse(c[1].body))).toEqual([
    {agreementId:initial.agreementId,action:"verify_bank"},{agreementId:initial.agreementId,action:"check_bank_payment"}]);
  expect(bankMock).toHaveBeenCalledWith(challenge.publishableKey,challenge.clientSecret);
  expect(container.textContent).toContain("payment has been verified and recorded");expect(container.innerHTML).not.toContain("_secret_");
  expect(button("Verify $666.33 with bank")).toBeUndefined();
});
test("successful bank SDK return alone cannot claim payment or unlock another debit",async()=>{
  await render(bankView);await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>challenge}).mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_payment_checked",outcome:"review_required"})});
  await click("Verify $666.33 with bank");expect(container.textContent).toContain("Payment is not yet verified");
  expect(button("Verify $666.33 with bank").disabled).toBe(true);expect(button("Check payment receipt").disabled).toBe(false);
  expect(container.textContent).not.toContain("payment has been verified and recorded");
});
test("bank double-click stays locked through the challenge and receipt check",async()=>{
  await render(bankView);await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  let finish!:()=>void;bankMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>challenge}).mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_payment_checked",outcome:"review_required"})});
  await act(async()=>{button("Verify $666.33 with bank").click();button("Verify $666.33 with bank").click();});
  expect(bankMock).toHaveBeenCalledTimes(1);expect(fetchMock).toHaveBeenCalledTimes(1);expect(button("Refresh records").disabled).toBe(true);
  await act(async()=>finish());expect(fetchMock).toHaveBeenCalledTimes(2);
});
test.each(["wrong amount","wrong period","lost response","malformed receipt"])("%s does not reveal a secret or a paid claim",async(problem)=>{
  await render(bankView);await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  if(problem==="lost response")fetchMock.mockRejectedValueOnce(new Error("SECRET_PROVIDER_ERROR"));
  else fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({...challenge,...problem==="wrong amount"?{amountCents:1}:{},
    ...problem==="wrong period"?{paymentNumber:3}:{}})});
  if(problem==="malformed receipt")fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"paid"})});
  await click("Verify $666.33 with bank");expect(container.innerHTML).not.toMatch(/_secret_|SECRET_PROVIDER_ERROR/);
  expect(container.textContent).not.toContain("payment has been verified and recorded");expect(button("Verify $666.33 with bank").disabled).toBe(true);
  if(problem!=="malformed receipt")expect(bankMock).not.toHaveBeenCalled();
});
test("checking a receipt never opens a bank challenge, even with a recorded confirmation",async()=>{
  await render({...bankView,confirmedQuoteId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"bank_payment_checked",outcome:"review_required"})});
  await click("Check payment receipt");expect(bankMock).not.toHaveBeenCalled();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({agreementId:initial.agreementId,action:"check_bank_payment"});
});
test("saving a card requires its own consent and a checkbox cannot trigger a payment",async()=>{
  await render({setupState:"not_started",setupRequestId:null,canSaveCard:true,canConfirmPayment:false});
  expect(button("Continue to secure card setup").disabled).toBe(true);
  await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  expect(button("Continue to secure card setup").disabled).toBe(false);expect(fetchMock).not.toHaveBeenCalled();
  expect(button("Review installment amount").disabled).toBe(true);
});
test("review does not authorize payment, and confirmation sends the reviewed identity only",async()=>{
  reviewResponse();await click("Review installment amount");
  expect(button("Confirm payment request").disabled).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("this version records your confirmation only");
  await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockImplementationOnce(async(_url:string,options:RequestInit)=>({ok:true,json:async()=>({status:"payment_confirmation_recorded",
    quote:{id:JSON.parse(options.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,confirmed:true}})}));
  await click("Confirm payment request");
  const body=JSON.parse(fetchMock.mock.calls[1][1].body),review=JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual({agreementId:initial.agreementId,action:"confirm_payment",quoteId:review.quoteId,accepted:true,consentVersion:"single-invoice-retry-v1"});
  expect(container.textContent).toContain("This is not a payment receipt");expect(container.textContent).not.toContain("Payment successful");
  expect(button("Confirm payment request")).toBeUndefined();
});
test("double clicks share one in-flight request and a lost result requires read-only refresh",async()=>{
  reviewResponse();await click("Review installment amount");await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  let reject!:(error:Error)=>void;fetchMock.mockImplementationOnce(()=>new Promise((_resolve,rejectFn)=>{reject=rejectFn;}));
  await act(async()=>{button("Confirm payment request").click();button("Confirm payment request").click();});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async()=>reject(new Error("SECRET")));
  expect(container.textContent).not.toContain("SECRET");expect(button("Confirm payment request").disabled).toBe(true);
  expect(container.textContent).toContain("Refresh records before continuing");
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({view:{...initial,confirmedQuoteId:JSON.parse(fetchMock.mock.calls[0][1].body).quoteId,setupEligible:false}})});
  await click("Refresh records");
  expect(fetchMock.mock.calls[2][1]).not.toHaveProperty("method");expect(container.textContent).toContain("confirmation is recorded");
});
test("expired reviews cannot be confirmed and a new explicit review gets a new identity",async()=>{
  reviewResponse(true);await click("Review installment amount");
  expect(container.textContent).toContain("This review expired");expect(button("Confirm payment request")).toBeUndefined();
  reviewResponse();await click("Review installment amount");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).quoteId).not.toBe(JSON.parse(fetchMock.mock.calls[1][1].body).quoteId);
  expect(button("Confirm payment request").disabled).toBe(true);
});
test.each(["action_required","payment_pending","terminal_unpaid","review_required","paid_accounted"])("%s offers no extra payment attempt",async(outcome)=>{
  await render({outcome,canConfirmPayment:false,setupEligible:false});
  expect(button("Confirm payment request")).toBeUndefined();expect(button("Review installment amount")).toBeUndefined();expect(fetchMock).not.toHaveBeenCalled();
  if(outcome==="action_required") expect(container.textContent).toContain("Your bank requires verification");
  if(outcome==="paid_accounted") expect(container.textContent).toContain("verified and recorded");
});
test("an unexpected success response cannot mark an installment paid",async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"paid",client_secret:"SECRET"})});
  await click("Review installment amount");expect(container.textContent).toContain("could not confirm");expect(container.textContent).not.toContain("SECRET");
  expect(button("Review installment amount").disabled).toBe(true);
});
test("verified accounting takes precedence over an earlier saved confirmation",async()=>{
  await render({outcome:"paid_accounted",confirmedQuoteId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",canConfirmPayment:false,setupEligible:false});
  expect(container.textContent).toContain("verified and recorded");expect(container.textContent).not.toContain("This is not a payment receipt");
  expect(button("Confirm payment request")).toBeUndefined();expect(fetchMock).not.toHaveBeenCalled();
});

test("pay-now mode clearly names the charge and requires new consent on the reviewed quote",async()=>{
  await render({canAttemptPayment:true});
  fetchMock.mockImplementationOnce(async(_url:string,o:RequestInit)=>({ok:true,json:async()=>({status:"payment_review_ready",quote:{
    id:JSON.parse(o.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,
    confirmed:false,consentVersion:"single-invoice-pay-now-v1"}})}));
  await click("Review installment amount");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe("review_pay_now");
  expect(button("Pay $666.33").disabled).toBe(true);expect(container.textContent).not.toContain("records your confirmation only");
  expect(container.textContent).toContain("This sends one payment attempt");
  await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockImplementationOnce(async(_url:string,o:RequestInit)=>({ok:true,json:async()=>({status:"payment_attempt_checked",outcome:"paid_accounted",quote:{
    id:JSON.parse(o.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,
    confirmed:true,consentVersion:"single-invoice-pay-now-v1"}})}));
  await click("Pay $666.33");expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({agreementId:initial.agreementId,
    action:"pay_now",quoteId:JSON.parse(fetchMock.mock.calls[0][1].body).quoteId,accepted:true,consentVersion:"single-invoice-pay-now-v1"});
  expect(button("Pay $666.33")).toBeUndefined();expect(container.textContent).toContain("verified and recorded");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
test("a record-only response cannot silently enter pay-now mode",async()=>{
  await render({canAttemptPayment:true});reviewResponse();await click("Review installment amount");
  expect(button("Pay $666.33")).toBeUndefined();expect(button("Confirm payment request")).toBeUndefined();
  expect(container.textContent).toContain("could not confirm");
});
test("an unexpected pay-now quote cannot upgrade a record-only screen",async()=>{
  fetchMock.mockImplementationOnce(async(_url:string,o:RequestInit)=>({ok:true,json:async()=>({status:"payment_review_ready",quote:{
    id:JSON.parse(o.body as string).quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+300,
    confirmed:false,consentVersion:"single-invoice-pay-now-v1"}})}));
  await click("Review installment amount");expect(button("Pay $666.33")).toBeUndefined();expect(container.textContent).toContain("could not confirm");
});
