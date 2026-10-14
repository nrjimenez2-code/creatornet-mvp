/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import ManualMentorshipPayment from "../components/ManualMentorshipPayment";
import {readManualAction,manualActionKey,saveManualAction,clearReleasedManualSelection} from "../lib/manualPaymentBrowser";
const mockToken=jest.fn(),mockNext=jest.fn(),mockSubmit=jest.fn(),mockAddress=jest.fn(),mockElements=jest.fn();
const mockCreate=jest.fn((kind:string)=>({mount:jest.fn(),destroy:jest.fn(),on:(event:string,cb:()=>void)=>{if(event==="ready")cb();},getValue:mockAddress}));
jest.mock("@stripe/stripe-js",()=>({loadStripe:async()=>({elements:mockElements,createPaymentMethod:mockToken,handleCardAction:mockNext})}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={requestId:id(1),buyerId:id(2),productId:id(3),mode:"full" as const,amountCents:10001};
let root:Root,host:HTMLDivElement;const mockFetch=jest.fn(),released=jest.fn();
const response=(body:object,ok=true)=>({ok,json:async()=>({requestId:id(1),...body})});
const observed=(status="processing",extra={})=>response({status:"payment_observed",paymentStatus:status,operationId:id(4),canSwitchPaymentMode:false,...extra});
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!;
async function render(mode:"full"|"installments"="full"){await act(async()=>root.render(createElement(ManualMentorshipPayment,{...scope,mode,onReleased:released})));}
async function click(text:string){await act(async()=>button(text).click());}
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);
  jest.clearAllMocks();localStorage.clear();global.fetch=mockFetch as any;process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_fixture";
  Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,fn:()=>Promise<void>)=>fn()}});
  mockElements.mockReturnValue({create:mockCreate,submit:mockSubmit});mockSubmit.mockResolvedValue({});
  mockAddress.mockResolvedValue({complete:true,value:{name:"Buyer",address:{country:"US",line1:"1 Main St",city:"Phoenix",state:"AZ",postal_code:"85001"}}});
  mockToken.mockResolvedValue({paymentMethod:{id:"pm_original"}});mockNext.mockResolvedValue({});
  mockFetch.mockResolvedValue(observed());
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
test.each(["full","installments"] as const)("%s uses Card Element while server retains amount and future-use authority",async mode=>{
  await render(mode);expect(mockElements).toHaveBeenCalledWith({appearance:{theme:"night"}});
  expect(mockCreate).toHaveBeenCalledWith("card",expect.objectContaining({hidePostalCode:true}));
  expect(mockCreate).toHaveBeenCalledWith("address",{mode:"billing",allowedCountries:["US"]});expect(mockFetch).not.toHaveBeenCalled();
});
test("saves token before dispatch and reuses it after a lost response without a new token or preparation",async()=>{
  mockFetch.mockResolvedValueOnce(response({status:"payment_prepared",amountCents:10001,currency:"usd"})).mockImplementationOnce(async()=>{
    expect(readManualAction(localStorage,scope)).toEqual({kind:"card",paymentMethodId:"pm_original"});throw Error("Lost response");
  });await render();await click("Pay $100.01");expect(host.textContent).toContain("Lost response");
  mockFetch.mockResolvedValue(observed());await click("Retry saved payment");
  expect(mockToken).toHaveBeenCalledTimes(1);expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({kind:"card",paymentMethodId:"pm_original"});
});
test("unavailable durable storage prevents confirmation dispatch",async()=>{
  mockFetch.mockResolvedValueOnce(response({status:"payment_prepared",amountCents:10001,currency:"usd"}));
  const spy=jest.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("Storage unavailable");});
  try{await render();await click("Pay $100.01");expect(mockFetch).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}
});
test("non-US or incomplete address prevents token creation",async()=>{
  mockAddress.mockResolvedValue({complete:true,value:{address:{country:"CA"}}});
  mockFetch.mockResolvedValueOnce(response({status:"payment_prepared",amountCents:10001,currency:"usd"}));
  await render();await click("Pay $100.01");expect(mockToken).not.toHaveBeenCalled();expect(mockFetch).toHaveBeenCalledTimes(1);
});
test("replacement uses proven failed phase; uncertainty removes the old replacement capability",async()=>{
  await render();mockFetch.mockResolvedValueOnce(observed("requires_payment_method",{replacementAllowed:true}));await click("Check payment status");
  mockFetch.mockResolvedValueOnce(observed("requires_payment_method",{replacementAllowed:true})).mockRejectedValueOnce(Error("Uncertain"));await click("Use replacement card");
  expect(readManualAction(localStorage,scope)).toEqual({kind:"card_replacement",paymentMethodId:"pm_original",previousOperationId:id(4)});
  expect(button("Use replacement card")).toBeUndefined();
});
test("bank verification is explicit, observes server state and persists post-authentication action",async()=>{
  await render();mockFetch.mockResolvedValueOnce(observed("requires_action"));await click("Check payment status");
  mockFetch.mockResolvedValueOnce(response({status:"authentication_required",operationId:id(4),clientSecret:"pi_fixture_secret_private"}))
    .mockResolvedValueOnce(observed("requires_confirmation"));await click("Verify with your bank");
  expect(mockNext).toHaveBeenCalledWith("pi_fixture_secret_private");
  expect(localStorage.getItem(manualActionKey(scope))).toBeNull();
  mockFetch.mockResolvedValueOnce(observed("requires_confirmation"));await click("Continue after bank verification");
  expect(readManualAction(localStorage,scope)).toEqual({kind:"after_authentication",previousOperationId:id(4)});
  expect(localStorage.getItem(manualActionKey(scope))).not.toContain("secret");
});
test("only verified original release unlocks switching",async()=>{
  await render();mockFetch.mockResolvedValueOnce(response({status:"reconciliation_required",canSwitchPaymentMode:false},false));await click("Stop unpaid payment");
  expect(released).not.toHaveBeenCalled();
  const at=new Date().toISOString();mockFetch.mockResolvedValueOnce(response({status:"released",releasedAt:at,canSwitchPaymentMode:true}));await click("Stop unpaid payment");
  expect(released).toHaveBeenCalledWith(at);expect(button("Pay $100.01")).toBeUndefined();
});
test("saved actions reject changed amount and malformed payload instead of silently replacing them",()=>{
  saveManualAction(localStorage,scope,{kind:"card",paymentMethodId:"pm_original"});
  expect(()=>readManualAction(localStorage,{...scope,amountCents:1})).toThrow();
  localStorage.setItem(manualActionKey(scope),JSON.stringify({version:1,scope,action:{kind:"card",paymentMethodId:"pm_original",amount:1}}));
  expect(()=>readManualAction(localStorage,scope)).toThrow();
});
test("successive payoff selections cannot reuse a prior browser card action",()=>{
  const payoff={...scope,mode:"monthly_payoff" as const,selectionId:id(7)};
  saveManualAction(localStorage,payoff,{kind:"card",paymentMethodId:"pm_original"});
  expect(manualActionKey({...payoff,selectionId:id(8)})).not.toBe(manualActionKey(payoff));
  expect(readManualAction(localStorage,{...payoff,selectionId:id(8)})).toBeNull();
  expect(readManualAction(localStorage,payoff)).toEqual({kind:"card",paymentMethodId:"pm_original"});
});
test("old release does not erase a newer payment selection",()=>{
  const key=`creatornet:mentorship-full-selection:${scope.buyerId}:${scope.productId}`;
  const newer={manualRequestId:id(99),quote:{terms:{buyerId:scope.buyerId,productId:scope.productId}}};
  localStorage.setItem(key,JSON.stringify(newer));clearReleasedManualSelection(localStorage,scope);expect(localStorage.getItem(key)).toBe(JSON.stringify(newer));
  localStorage.setItem(key,JSON.stringify({...newer,manualRequestId:scope.requestId}));clearReleasedManualSelection(localStorage,scope);expect(localStorage.getItem(key)).toBeNull();
});
test("missing browser coordination blocks payable actions but leaves status recovery available",async()=>{
  Object.defineProperty(navigator,"locks",{configurable:true,value:undefined});await render();await click("Pay $100.01");
  expect(mockFetch).not.toHaveBeenCalled();expect(mockToken).not.toHaveBeenCalled();await click("Check payment status");expect(mockFetch).toHaveBeenCalledTimes(1);
});
