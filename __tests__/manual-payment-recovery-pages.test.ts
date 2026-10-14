/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let mockParams=new URLSearchParams(),mockPaymentProps:any;const mockReplace=jest.fn(),mockRouter={replace:mockReplace};
jest.mock("next/navigation",()=>({useSearchParams:()=>mockParams,useRouter:()=>mockRouter}));
jest.mock("../components/ManualMentorshipPayment",()=>({__esModule:true,default:(props:any)=>{mockPaymentProps=props;return createElement("div",{"data-payment":props.requestId},"Original payment form");}}));
import Recovery from "../app/purchase/manual/page";
import Return from "../app/purchase/payment/return/page";
let host:HTMLDivElement,root:Root;const mockFetch=jest.fn();
const terms=()=>({buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),title:"Original mentorship",billing:"One payment",amountCents:10001,currency:"usd",kind:"one_time"});
const full=()=>({requestId:id(1),status:"saved_selection",terms:terms(),buyerId:id(2),productId:id(4),fingerprint:"a".repeat(64),providerOperationsAllowed:false,canSwitchPaymentMode:false});
const installments=()=>({...full(),status:"reserved",terms:{...terms(),kind:"fixed_total_installments",paymentCount:2,payments:[{number:1,amountCents:5001},{number:2,amountCents:5000}]}});
const reply=(body:any,ok=true)=>({ok,json:async()=>body});
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;jest.clearAllMocks();localStorage.clear();mockPaymentProps=null;
  host=document.createElement("div");document.body.append(host);root=createRoot(host);global.fetch=mockFetch as any;
  mockParams=new URLSearchParams({request_id:id(1),mode:"full"});mockFetch.mockResolvedValue(reply(full()));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const render=async(component=Recovery)=>act(async()=>root.render(createElement(component)));
test.each(["full","installments"])("%s recovery loads original terms only and does not send a payable action",async mode=>{
  mockParams.set("mode",mode);mockFetch.mockResolvedValue(reply(mode==="full"?full():installments()));await render();
  expect(mockPaymentProps).toMatchObject({requestId:id(1),buyerId:id(2),mode,amountCents:mode==="full"?10001:5001});
  expect(mockFetch).toHaveBeenCalledTimes(1);expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
});
test.each(["full","installments"])("%s product discovery works with empty storage and freezes its resolved request link",async mode=>{
  mockParams=new URLSearchParams({product_id:id(4),mode});mockFetch.mockResolvedValue(reply(mode==="full"?full():installments()));await render();
  expect(mockFetch.mock.calls[0][0]).toBe(mode==="full"?"/api/checkout/manual?product_id="+id(4):"/api/installments/reservations?product_id="+id(4));
  expect(mockPaymentProps).toMatchObject({requestId:id(1),mode});
  expect(host.querySelector(`a[href="/purchase/manual?request_id=${id(1)}&mode=${mode}"]`)).not.toBeNull();
});
test("product discovery refuses a different product and sends no acceptance request",async()=>{
  mockParams=new URLSearchParams({product_id:id(99),mode:"full"});await render();expect(mockPaymentProps).toBeNull();expect(mockFetch).toHaveBeenCalledTimes(1);
});
test.each(["wrong request","bad fingerprint","wrong status","owner mismatch","release without permission","released without timestamp","invalid installment sum"])
("%s never mounts payment controls or unlocks switching",async issue=>{
  const body:any=issue==="invalid installment sum"?installments():full();
  if(issue==="wrong request")body.requestId=id(99);if(issue==="bad fingerprint")body.fingerprint="bad";
  if(issue==="wrong status")body.status="paid";if(issue==="owner mismatch")body.buyerId=id(99);
  if(issue==="release without permission")body.releasedAt=new Date().toISOString();
  if(issue==="released without timestamp")body.status="released";
  if(issue==="invalid installment sum"){mockParams.set("mode","installments");body.terms.payments[1].amountCents=1;}
  mockFetch.mockResolvedValue(reply(body));await render();expect(mockPaymentProps).toBeNull();expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
test("verified release clears only this original selection and hides the form",async()=>{
  const key=`creatornet:mentorship-full-selection:${id(2)}:${id(4)}`;
  localStorage.setItem(key,JSON.stringify({manualRequestId:id(1),quote:{terms:terms()}}));
  mockFetch.mockResolvedValue(reply({...full(),status:"released",releasedAt:new Date().toISOString(),canSwitchPaymentMode:true}));await render();
  expect(localStorage.getItem(key)).toBeNull();expect(mockPaymentProps).toBeNull();expect(host.textContent).toContain("This unpaid checkout was released");
});
test("request navigation cannot render old purchase state under a new request",async()=>{
  await render();mockPaymentProps=null;mockParams=new URLSearchParams({request_id:id(99),mode:"full"});
  mockFetch.mockImplementation(()=>new Promise(()=>{}));await render();expect(mockPaymentProps).toBeNull();expect(host.textContent).toContain("Loading your saved purchase");
});
test("bank return removes secret/status query and resolves the original without claiming success",async()=>{
  mockParams=new URLSearchParams({attempt:id(6),payment_intent_client_secret:"secret_private",redirect_status:"succeeded"});
  window.history.replaceState(null,"","/purchase/payment/return?"+mockParams);
  mockFetch.mockResolvedValue(reply({requestId:id(1),mode:"full"}));await render(Return);
  expect(window.location.search).toBe("?attempt="+id(6));
  expect(mockFetch.mock.calls[0][0]).toBe("/api/checkout/manual/resolve?attempt_id="+id(6));
  expect(mockReplace).toHaveBeenCalledWith(`/purchase/manual?request_id=${id(1)}&mode=full`);
  expect(host.textContent).not.toContain("Payment successful");
});
test.each(["bad attempt","failed resolver","bad mode","bad request"])("%s cannot navigate to a success or new checkout",async issue=>{
  mockParams=new URLSearchParams({attempt:issue==="bad attempt"?"bad":id(6)});
  mockFetch.mockResolvedValue(reply({requestId:issue==="bad request"?"bad":id(1),mode:issue==="bad mode"?"other":"full"},issue!=="failed resolver"));
  await render(Return);expect(mockReplace).not.toHaveBeenCalled();if(issue==="bad attempt")expect(mockFetch).not.toHaveBeenCalled();
});
