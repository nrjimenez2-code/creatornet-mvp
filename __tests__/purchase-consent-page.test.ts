/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { productPurchaseTerms } from "@/lib/purchaseConsent";
let mockParams = new URLSearchParams("product_id=owned-product");
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }));
import PurchaseReviewPage from "@/app/purchase/review/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: Root, container: HTMLDivElement;
const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const quote = (kind = "course", amount = 10000) => productPurchaseTerms({ id: "owned-product", creator_id: "owned-creator",
  title: "Owned offer", type: kind, description: "Promised service", price_cents: amount, currency: "usd" }, "signed-in-buyer", null);
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_key:string,fn:()=>Promise<void>)=>fn()}});
  mockParams = new URLSearchParams("product_id=owned-product"); mockFetch.mockReset(); globalThis.fetch = mockFetch;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
const render = async () => { await act(async () => root.render(createElement(PurchaseReviewPage))); };
const button = (text: string) => [...container.querySelectorAll("button")].find(value => value.textContent === text)!;

test("#6 actual review renders server price and policy while explicit acceptance starts unchecked", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())); await render();
  expect(container.textContent).toContain("$100.00"); expect(container.textContent).toContain("Promised service");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
  expect(container.querySelector('a[href="/legal/purchase-agreement"]')).not.toBeNull();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test("#6 explicit acceptance sends only the displayed fingerprint, not a browser price or buyer identity", async () => {
  const displayed = quote("call");
  mockFetch.mockResolvedValueOnce(reply(displayed)).mockImplementationOnce(() => new Promise<Response>(() => {}));
  await render(); expect(container.textContent).toContain(displayed.terms.policy.calls);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[1][0]).toBe("/api/checkout");
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ type: "product", product_id: "owned-product",
    purchase_consent: { accepted: true, version: displayed.terms.version, fingerprint: displayed.fingerprint } });
  expect(button("Opening checkout...").disabled).toBe(true);
});
test("#6 loading failure offers a working retry without accepting terms", async () => {
  mockFetch.mockResolvedValueOnce(reply({ error: "Offer temporarily unavailable" }, false)).mockResolvedValueOnce(reply(quote()));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toBe("Offer temporarily unavailable");
  await act(async () => button("Reload offer").click());
  expect(container.textContent).toContain("$100.00"); expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 a stale-price refusal can reload the current offer and requires a new explicit acceptance", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply({ error: "Review and accept the current purchase terms before payment." }, false))
    .mockResolvedValueOnce(reply(quote("course", 12000)));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("current purchase terms");
  await act(async () => button("Review current offer").click());
  expect(container.textContent).toContain("$120.00"); expect(container.textContent).not.toContain("$100.00");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 changing the selected offer never carries over the prior checkbox acceptance", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply(quote("course", 15000)));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  mockParams = new URLSearchParams("product_id=second-product"); await render();
  expect(container.textContent).toContain("$150.00"); expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("#6 an unsafe checkout URL is refused instead of navigating", async () => {
  mockFetch.mockResolvedValueOnce(reply(quote())).mockResolvedValueOnce(reply({ url: "javascript:alert(1)" }));
  await render(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Agree and continue to payment").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid checkout destination.");
});

test("timed review displays service length and payment independence before acceptance", async () => {
  const timed = productPurchaseTerms({ id: "owned-product", creator_id: "owned-creator", type: "mentorship",
    title: "Ten month mentorship", price_cents: 10000, fixed_service_months: 10 }, "signed-in-buyer", null);
  mockFetch.mockResolvedValueOnce(reply(timed)); await render();
  expect(container.textContent).toContain("10 calendar months from the first captured payment, independent of payment count.");
  expect(container.textContent).toContain("One payment for the listed offer");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
});



const requestId="10000000-0000-4000-8000-000000000088";
function withChoices(amount=10001) {
  const product={id:"owned-product",creator_id:"owned-creator",title:"Mentorship",description:"Promised service",type:"mentorship",amount_cents:amount,currency:"usd",fixed_service_months:10,installment_options:[3]};
  const fees={enabled:true,basisPoints:290,fixedCents:30,version:"synthetic"};
  return {...productPurchaseTerms(product,"signed-in-buyer","owned-post"),installmentChoices:[mentorshipInstallmentQuote({product,buyerId:"signed-in-buyer",postId:"owned-post",paymentCount:3,firstPaymentFees:fees,renewalFees:fees})]};
}
const selectInstallments=()=>act(async()=>container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
const acceptTerms=()=>act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
test("manual full choice persists original request before acceptance and does not open hosted checkout",async()=>{
  const offer={...withChoices(),manualCheckoutEnabled:true},uuid=jest.spyOn(crypto,"randomUUID").mockReturnValue(requestId);
  mockFetch.mockResolvedValueOnce(reply(offer)).mockImplementationOnce(async(url,options)=>{
    expect(url).toBe("/api/checkout/manual");
    expect(JSON.parse(localStorage.getItem("creatornet:mentorship-full-selection:signed-in-buyer:owned-product")!).manualRequestId).toBe(requestId);
    expect(JSON.parse(options!.body as string)).toEqual({request_id:requestId,product_id:"owned-product",post_id:"owned-post",
      acceptance:{accepted:true,version:offer.terms.version,fingerprint:offer.fingerprint}});
    return reply({requestId,status:"saved_selection",buyerId:"signed-in-buyer",productId:"owned-product",fingerprint:offer.fingerprint});
  });
  try{await render();await acceptTerms();await act(async()=>button("Agree and continue to payment").click());
    expect(mockFetch).toHaveBeenCalledTimes(2);expect(container.querySelector(`a[href="/purchase/manual?mode=full&request_id=${requestId}"]`)).not.toBeNull();
  }finally{uuid.mockRestore();}
});
test("manual installment choice preserves its marker and exposes original payment recovery",async()=>{
  const offer={...withChoices(),manualCheckoutEnabled:true},uuid=jest.spyOn(crypto,"randomUUID").mockReturnValue(requestId),q=offer.installmentChoices[0];
  mockFetch.mockResolvedValueOnce(reply(offer)).mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:q.fingerprint,terms:q.terms,providerOperationsAllowed:false}));
  try{await render();await selectInstallments();await acceptTerms();await act(async()=>button("Agree and continue to payment").click());
    expect(JSON.parse(localStorage.getItem("creatornet:mentorship-selection:signed-in-buyer:owned-product")!).manual).toBe(true);
    expect(container.querySelector(`a[href="/purchase/manual?mode=installments&request_id=${requestId}"]`)).not.toBeNull();
  }finally{uuid.mockRestore();}
});
test("full and creator-approved installment options share the review and reset consent",async()=>{
  mockFetch.mockResolvedValueOnce(reply(withChoices()));await render();
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  await acceptTerms();expect(button("Agree and continue to payment").disabled).toBe(false);
  await selectInstallments();expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(container.textContent).toContain("$33.35");expect(container.textContent).toContain("2 calendar months after the first payment");
  expect(container.textContent).toContain("fixed-price purchase, not a cancel-anytime membership");
  expect(container.textContent).toContain("10 calendar months");expect(mockFetch).toHaveBeenCalledTimes(1);
  await acceptTerms();await act(async()=>container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click());
  expect(button("Agree and continue to payment").disabled).toBe(true);
});
test("lost installment reply persists exact acceptance and blocks mode switching",async()=>{
  const uuid=jest.spyOn(crypto,"randomUUID").mockReturnValue(requestId),offer=withChoices();
  try {
    mockFetch.mockResolvedValueOnce(reply(offer)).mockImplementationOnce(async(_url,options)=>{
      const saved=JSON.parse(localStorage.getItem("creatornet:mentorship-selection:signed-in-buyer:owned-product")!);
      expect(saved.request).toEqual(JSON.parse(String(options!.body)));throw Error("lost reply");
    });
    await render();await selectInstallments();await acceptTerms();await act(async()=>button("Agree and save installment selection").click());
    expect(mockFetch.mock.calls[1][0]).toBe("/api/installments/reservations");
    const original=JSON.parse(String(mockFetch.mock.calls[1][1]!.body));
    expect(original).toEqual({request_id:requestId,product_id:"owned-product",post_id:"owned-post",payment_count:3,
      acceptance:{accepted:true,version:offer.terms.version,fingerprint:offer.installmentChoices[0].fingerprint}});
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:offer.installmentChoices[0].fingerprint,
      terms:offer.installmentChoices[0].terms,providerOperationsAllowed:false}));
    await act(async()=>button("Recover saved selection").click());
    expect(mockFetch.mock.calls[2][0]).toBe(`/api/installments/reservations/${requestId}`);
    expect(mockFetch.mock.calls[2][1]!.method).toBeUndefined();
    expect(container.textContent).toContain("This is not a payment receipt");
    expect(container.querySelector(`a[href="/payments/mentorship/${requestId}"]`)).not.toBeNull();
  } finally {uuid.mockRestore();}
});
test("remounted selection retains original quote after catalog changes and GET 404 retries original request",async()=>{
  const offer=withChoices(),selected=offer.installmentChoices[0];
  const original={request_id:requestId,product_id:"owned-product",post_id:"owned-post",payment_count:3,acceptance:{accepted:true,version:selected.terms.version,fingerprint:selected.fingerprint}};
  localStorage.setItem("creatornet:mentorship-selection:signed-in-buyer:owned-product",JSON.stringify({request:original,quote:selected}));
  mockFetch.mockResolvedValueOnce(reply(withChoices(20001)));
  await render();expect(container.textContent).toContain("$100.01");expect(container.textContent).not.toContain("$200.01");
  expect(mockFetch).toHaveBeenCalledTimes(1);expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  mockFetch.mockResolvedValueOnce({...reply({},false),status:404} as Response).mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false}));
  await act(async()=>button("Recover saved selection").click());
  expect(JSON.parse(String(mockFetch.mock.calls[2][1]!.body))).toEqual(original);
  expect(container.textContent).toContain("Your installment selection is saved");
});
test("unknown saved-selection response cannot unlock another mode or claim payment",async()=>{
  const offer=withChoices(),selected=offer.installmentChoices[0];
  localStorage.setItem("creatornet:mentorship-selection:signed-in-buyer:owned-product",JSON.stringify({quote:selected,request:{request_id:requestId,product_id:"owned-product",post_id:"owned-post",payment_count:3,acceptance:{accepted:true,version:selected.terms.version,fingerprint:selected.fingerprint}}}));
  mockFetch.mockResolvedValueOnce(reply(offer)).mockResolvedValueOnce(reply({requestId:"other",status:"reserved"}));
  await render();await act(async()=>button("Recover saved selection").click());
  expect(container.textContent).toContain("selection is not confirmed");expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(container.querySelector(`a[href="/payments/mentorship/${requestId}"]`)).toBeNull();
});


test("saved request link reads accepted terms without the catalog or local storage",async()=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false}));
  await render();expect(mockFetch.mock.calls[0][0]).toBe(`/api/installments/reservations/${requestId}`);
  expect(mockFetch).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("$100.01");
  expect(container.textContent).toContain("This is not a payment receipt");expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(localStorage.length).toBe(0);
});
test("unknown or unavailable original request never falls back to a fresh catalog checkout",async()=>{
  mockParams=new URLSearchParams(`request_id=${requestId}`);mockFetch.mockResolvedValueOnce({...reply({error:"Saved payment plan not found."},false),status:404} as Response);
  await render();expect(container.textContent).toContain("Saved payment plan not found");expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(button("Agree and continue to payment")).toBeUndefined();
});
test("a previously verified reservation returning 404 is not recreated",async()=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false}))
    .mockResolvedValueOnce({...reply({},false),status:404} as Response);
  await render();await act(async()=>button("Recover saved selection").click());
  expect(mockFetch).toHaveBeenCalledTimes(2);expect(mockFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
  expect(container.textContent).toContain("selection is not confirmed");
});


test("uncertain full-payment submission persists original request and blocks installment switching",async()=>{
  const offer=withChoices();mockFetch.mockResolvedValueOnce(reply(offer)).mockImplementationOnce(async(_url,options)=>{
    expect(JSON.parse(localStorage.getItem("creatornet:mentorship-full-selection:signed-in-buyer:owned-product")!).request).toEqual(JSON.parse(String(options!.body)));
    throw Error("lost checkout reply");
  });
  await render();await acceptTerms();await act(async()=>button("Agree and continue to payment").click());
  const original=JSON.parse(String(mockFetch.mock.calls[1][1]!.body));
  expect(original.post_id).toBe("owned-post");expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  mockFetch.mockResolvedValueOnce(reply(withChoices(20001)));
  await act(async()=>button("Review current offer").click());expect(container.textContent).toContain("$100.01");expect(container.textContent).not.toContain("$200.01");
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  await acceptTerms();await act(async()=>button("Agree and continue to payment").click());
  expect(mockFetch).toHaveBeenCalledTimes(3);expect(button("Agree and continue to payment").disabled).toBe(true);
  expect(container.querySelector('a[href="/purchase/review?product_id=owned-product&full_recovery=1"]')).not.toBeNull();
});

const fullCapability={attemptId:requestId,productId:"owned-product",status:"saved_checkout",canRecover:true,accessGranted:false,canSwitchPaymentMode:false};
test("full recovery link reads owner capability without catalog, storage or new consent",async()=>{
  mockParams=new URLSearchParams("product_id=owned-product&full_recovery=1");
  const storage=jest.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("no storage");});
  try{
    mockFetch.mockResolvedValueOnce(reply(fullCapability));await render();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/checkout/recover?product_id=owned-product");
    expect(mockFetch.mock.calls[0][1]?.method).toBeUndefined();expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")).toBeNull();expect(button("Recover original checkout").disabled).toBe(false);
  }finally{storage.mockRestore();}
});
test.each(["disabled","missing","wrong product","unlock claim"])("full recovery cannot dispatch after %s capability",async issue=>{
  mockParams=new URLSearchParams("product_id=owned-product&full_recovery=1");
  mockFetch.mockResolvedValueOnce(reply({...fullCapability,canRecover:issue!=="disabled",productId:issue==="wrong product"?"other":"owned-product",
    canSwitchPaymentMode:issue==="unlock claim"},issue!=="missing"));await render();
  expect(button("Recover original checkout")).toBeUndefined();expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(container.querySelector("input")).toBeNull();
});
test.each(["lost reply","reconciliation","wrong product","unsafe URL","release claim"])("full recovery preserves lock after %s",async issue=>{
  mockParams=new URLSearchParams("product_id=owned-product&full_recovery=1");mockFetch.mockResolvedValueOnce(reply(fullCapability));
  if(issue==="lost reply")mockFetch.mockRejectedValueOnce(Error("lost reply"));
  else mockFetch.mockResolvedValueOnce(reply({attemptId:requestId,productId:issue==="wrong product"?"other":"owned-product",sessionId:"cs_original",
    status:issue==="reconciliation"?"reconciliation_required":"checkout_open",accessGranted:false,canSwitchPaymentMode:issue==="release claim",
    url:"https://untrusted.invalid/payment"}));
  await render();await act(async()=>button("Recover original checkout").click());
  expect(mockFetch.mock.calls[1][0]).toBe("/api/checkout/recover");expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({productId:"owned-product",attemptId:requestId});
  expect(container.querySelector("input")).toBeNull();expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(mockFetch.mock.calls.some(([url])=>url==="/api/checkout")).toBe(false);
  mockFetch.mockRejectedValueOnce(Error("still uncertain"));await act(async()=>button("Recover original checkout").click());
  expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({productId:"owned-product",attemptId:requestId});
});
test("catalog failure still exposes explicit full recovery without creating another payment",async()=>{
  mockFetch.mockResolvedValueOnce(reply({error:"Catalog unavailable"},false));await render();
  expect(container.querySelector('a[href="/purchase/review?product_id=owned-product&full_recovery=1"]')).not.toBeNull();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test.each(["release","lost reply","still pending","wrong attempt","newer same-price selection"])("full stop requires exact release readback: %s",async outcome=>{
 const offer=withChoices(),key="creatornet:mentorship-full-selection:signed-in-buyer:owned-product";
 localStorage.setItem(key,JSON.stringify({quote:offer,request:{product_id:"owned-product"}}));
 mockParams=new URLSearchParams("product_id=owned-product&full_recovery=1");
 const capability={...fullCapability,canStopUnpaid:true,buyerId:"signed-in-buyer",fingerprint:offer.fingerprint};
 mockFetch.mockResolvedValueOnce(reply(capability)).mockImplementationOnce(async()=>{
  if(outcome==="newer same-price selection")localStorage.setItem(key,JSON.stringify({quote:offer,request:{product_id:"owned-product"},attemptId:"10000000-0000-4000-8000-000000000099"}));
  if(outcome==="lost reply")throw Error("lost stop reply");return reply({status:"released",releaseAllowed:true});
 }).mockResolvedValueOnce(reply(outcome==="still pending"?capability:{...capability,status:"released",attemptId:outcome==="wrong attempt"?"10000000-0000-4000-8000-000000000099":requestId,
   canRecover:false,canStopUnpaid:false,canSwitchPaymentMode:true,releasedAt:new Date().toISOString()}));
 await render();expect(JSON.parse(localStorage.getItem(key)!).attemptId).toBe(requestId);
 await act(async()=>button("Stop original unpaid checkout").click());
 expect(mockFetch.mock.calls[1][0]).toBe("/api/checkout/stop");expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({attemptId:requestId});
 expect(mockFetch.mock.calls[2][0]).toBe(`/api/checkout/recover?product_id=owned-product&attempt_id=${requestId}`);
 if(["still pending","wrong attempt"].includes(outcome)){
  expect(container.textContent).not.toContain("Review current offer and choose payment mode");expect(localStorage.getItem(key)).not.toBeNull();
 }else{
  expect(container.textContent).toContain("Review current offer and choose payment mode");
  if(outcome==="newer same-price selection")expect(JSON.parse(localStorage.getItem(key)!).attemptId).toContain("0099");else expect(localStorage.getItem(key)).toBeNull();
 }
 expect(container.querySelector("input")).toBeNull();
});
test("historical full recovery link stays bound to the original attempt",async()=>{
 mockParams=new URLSearchParams(`product_id=owned-product&full_recovery=1&full_attempt_id=${requestId}`);
 mockFetch.mockResolvedValueOnce(reply(fullCapability));await render();
 expect(mockFetch.mock.calls[0][0]).toBe(`/api/checkout/recover?product_id=owned-product&attempt_id=${requestId}`);
 expect(button("Stop original unpaid checkout")).toBeUndefined();
});


test("verified request-link recovery remains readable when browser storage is unavailable",async()=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  const saved={requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false};
  const storage=jest.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("storage unavailable");});
  try {
    mockFetch.mockResolvedValue(reply(saved));await render();await act(async()=>button("Recover saved selection").click());
    expect(mockFetch).toHaveBeenCalledTimes(2);expect(mockFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
    expect(container.textContent).toContain("Your installment selection is saved");
  } finally {storage.mockRestore();}
});


test("missing catalog offer recovers the buyer's original plan by product without local storage",async()=>{
  const selected=withChoices().installmentChoices[0];
  mockFetch.mockResolvedValueOnce({...reply({error:"Offer not available."},false),status:404} as Response)
    .mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false}));
  await render();expect(mockFetch.mock.calls[1][0]).toBe("/api/installments/reservations?product_id=owned-product");
  expect(mockFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
  expect(container.textContent).toContain("Your installment selection is saved");expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(localStorage.length).toBe(0);
});

test.each(["matching","newer","storage unavailable"])("server-confirmed release preserves history and clears only matching request: %s",async scenario=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  const key="creatornet:mentorship-selection:signed-in-buyer:owned-product";
  const pending={request:{request_id:scenario==="newer"?"10000000-0000-4000-8000-000000000099":requestId,product_id:"owned-product",post_id:"owned-post",payment_count:3,
    acceptance:{accepted:true,version:selected.terms.version,fingerprint:selected.fingerprint}},quote:selected};
  localStorage.setItem(key,JSON.stringify(pending));
  const unavailable=scenario==="storage unavailable"?jest.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("unavailable");}):null;
  try{
    mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,
      providerOperationsAllowed:false,releasedAt:new Date().toISOString()}));
    await render();expect(container.textContent).toContain("released after its unpaid checkout was stopped");
    expect(container.querySelector(`a[href="/payments/mentorship/${requestId}"]`)).toBeNull();
    expect([...container.querySelectorAll("a")].find(a=>a.textContent==="Review current offer and choose payment mode")?.getAttribute("href"))
      .toBe("/purchase/review?product_id=owned-product&post_id=owned-post");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);expect(mockFetch.mock.calls[0][1]?.method).toBeUndefined();
    if(scenario==="matching")expect(localStorage.getItem(key)).toBeNull();
    if(scenario==="newer")expect(JSON.parse(localStorage.getItem(key)!).request.request_id).toBe(pending.request.request_id);
  }finally{unavailable?.mockRestore();}
});
test("invalid server release timestamp cannot unlock a new selection",async()=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false,releasedAt:"invalid"}));
  await render();expect(container.textContent).toContain("release could not be verified");
  expect(container.textContent).not.toContain("Review current offer and choose payment mode");
});

test.each(["released","lost reply","unsettled"])("stop control recovers original request after %s",async outcome=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  const saved={requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false,canAbandonUnpaid:true};
  mockFetch.mockResolvedValueOnce(reply(saved));
  if(outcome==="lost reply")mockFetch.mockRejectedValueOnce(Error("lost response"));else mockFetch.mockResolvedValueOnce(reply({status:"released"}));
  mockFetch.mockResolvedValueOnce(reply({...saved,releasedAt:outcome==="unsettled"?null:new Date().toISOString()}));
  await render();await act(async()=>button("Stop unpaid checkout").click());
  expect(mockFetch.mock.calls[1][0]).toBe(`/api/installments/reservations/${requestId}`);
  expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({action:"abandon_unpaid"});
  expect(mockFetch.mock.calls[2][0]).toBe(`/api/installments/reservations/${requestId}`);expect(mockFetch.mock.calls[2][1]?.method).toBeUndefined();
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  if(outcome==="unsettled"){
    expect(container.textContent).toContain("still needs confirmation");expect(container.textContent).not.toContain("Review current offer and choose payment mode");
  }else expect(container.textContent).toContain("released after its unpaid checkout was stopped");
});
test("saved selection without server capability never offers abandonment",async()=>{
  const selected=withChoices().installmentChoices[0];mockParams=new URLSearchParams(`request_id=${requestId}`);
  mockFetch.mockResolvedValueOnce(reply({requestId,status:"reserved",fingerprint:selected.fingerprint,terms:selected.terms,providerOperationsAllowed:false}));
  await render();expect(button("Stop unpaid checkout")).toBeUndefined();expect(mockFetch).toHaveBeenCalledTimes(1);
});
