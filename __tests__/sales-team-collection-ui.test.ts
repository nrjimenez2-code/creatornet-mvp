/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let viewer="buyer";const navigation=jest.fn(),session=jest.fn(),submit=jest.fn(),token=jest.fn(),bank=jest.fn(),billing=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:viewer,session:{access_token:"verified-session"},loading:false})}));
jest.mock("@/lib/browserSession",()=>({prepareSessionNavigation:()=>navigation()}));
jest.mock("@/lib/supabaseClient",()=>({createClient:()=>({auth:{getSession:session}})}));
const element=()=>({on:(event:string,fn:()=>void)=>{if(event==="ready")fn();},mount:jest.fn(),destroy:jest.fn(),getValue:()=>billing()});
jest.mock("@stripe/stripe-js",()=>({loadStripe:async()=>({elements:()=>({create:()=>element(),submit:()=>submit()}),createConfirmationToken:(...args:unknown[])=>token(...args),handleNextAction:(...args:unknown[])=>bank(...args)})}));
import TeamBuyerPayment from "@/components/TeamBuyerPayment";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;let phase:string,enabled:boolean,obligationId:string|undefined,periodNumber:number|undefined,nextPayment:Record<string,unknown>|undefined,laterEnabled:boolean;
let consentResponse:Record<string,unknown>;
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
const view=()=>({phase,amountCents:3333,currency:"usd",saveForFuture:true,pendingRequest:null,...(obligationId?{obligationId,periodNumber}:{}),...(phase==="requires_action"?{clientSecret:"pi_original_secret_owned"}:{})});
const buttons=()=>Array.from(container.querySelectorAll("button"));const button=(text:string)=>buttons().find(b=>b.textContent?.includes(text))!;
const click=async(text:string)=>{await act(async()=>{button(text).click();await new Promise(r=>setTimeout(r,20));});};
const mount=async()=>{await act(async()=>{root.render(createElement(TeamBuyerPayment,{saleId:"sale",userId:viewer}));await new Promise(r=>setTimeout(r,20));});await act(async()=>{await new Promise(r=>setTimeout(r,20));});};
const savedConsent=(fingerprint="a".repeat(64),automaticAuthorized=true)=>({savedMethodConsentRequired:true,savedMethodConsentEnabled:true,savedMethodConsent:{fingerprint,authorization:automaticAuthorized?"I authorize the exact accepted monthly payments for this sale.":"Future automatic debits remain stopped.",paymentKind:"installments",payments:[{number:1,amountCents:3333},{number:2,amountCents:3333},{number:3,amountCents:3335}],automaticAuthorized,acceptedBilling:"Payments stop after the agreed total."}});
const checkConsent=async()=>{await act(async()=>{container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();});};
beforeEach(()=>{
 jest.clearAllMocks();viewer="buyer";phase="not_started";enabled=true;obligationId=undefined;periodNumber=undefined;nextPayment=undefined;laterEnabled=false;sessionStorage.clear();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 consentResponse={};
 navigation.mockResolvedValue(true);session.mockImplementation(async()=>({data:{session:{user:{id:viewer}}},error:null}));submit.mockResolvedValue({});billing.mockResolvedValue({complete:true,value:{name:"Buyer",address:{country:"US",line1:"1 Main",city:"Phoenix",state:"AZ",postal_code:"85001"}}});
 token.mockResolvedValue({confirmationToken:{id:"ctoken_original"}});bank.mockResolvedValue({});
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>{const action=options?.body?JSON.parse(String(options.body)).action:null;if(action==="prepare")phase="needs_method";if(action==="prepare_next"){phase="needs_method";obligationId="later-owned";periodNumber=2;nextPayment=undefined;enabled=true;}if(action==="confirm"||action==="reconfirm")phase="captured_pending_receipt";if(action==="stop")phase="stopped";return response({payment:view(),collectionEnabled:enabled,nextPayment,laterCollectionEnabled:laterEnabled,...consentResponse});});
});afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("viewing an accepted review never creates a customer, intent or confirmation automatically",async()=>{
 await mount();expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(token).not.toHaveBeenCalled();expect(button("Prepare payment").disabled).toBe(false);
 expect(session).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();
});
test("saved-card permission starts unchecked and prevents token submission until explicitly accepted",async()=>{
 phase="needs_method";consentResponse=savedConsent();await mount();expect(button("Pay $33.33").disabled).toBe(true);await click("Pay $33.33");expect(token).not.toHaveBeenCalled();expect(container.textContent).toContain("$33.35");
 await checkConsent();await click("Pay $33.33");expect(token).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null)).toContainEqual(expect.objectContaining({action:"confirm",saved_method_consent:{accepted:true,fingerprint:"a".repeat(64)}}));
});
test("a changed saved-card quote clears the earlier checkbox acceptance",async()=>{
 phase="needs_method";consentResponse=savedConsent();await mount();await checkConsent();expect(button("Pay $33.33").disabled).toBe(false);consentResponse=savedConsent("b".repeat(64));await click("Refresh payment status");expect(button("Pay $33.33").disabled).toBe(true);expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);expect(token).not.toHaveBeenCalled();
});
test("uncertain acknowledgement retains the exact saved-card consent without creating another token",async()=>{
 phase="needs_method";consentResponse=savedConsent();await mount();await checkConsent();const original=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((path,o)=>o.body&&JSON.parse(o.body).action==="confirm"?Promise.reject(Error("lost acknowledgement")):original(path,o));await click("Pay $33.33");
 await act(async()=>root.unmount());root=createRoot(container);await mount();await click("Check original confirmation");expect(token).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null)).toContainEqual(expect.objectContaining({action:"resume",saved_method_consent:{accepted:true,fingerprint:"a".repeat(64)}}));
});
test("a manual card change preserves the saved automatic-debit Stop in its consent text",async()=>{
 phase="needs_method";consentResponse=savedConsent("a".repeat(64),false);await mount();expect(container.textContent).toContain("Future automatic debits remain stopped");expect(container.textContent).toContain("manual payments only");expect(button("Pay $33.33").disabled).toBe(true);
});
test("Payment Element creates one token, saves original identity and sends no client-selected amounts",async()=>{
 await mount();await click("Prepare payment");await click("Pay $33.33");const post=fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null).find(b=>b?.action==="confirm");
 expect(post).toEqual({action:"confirm",request_id:expect.any(String),confirmation_token:"ctoken_original"});expect(token).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("verifying the receipt");
 expect(container.textContent).not.toContain("Your payment receipt is verified");expect(sessionStorage.length).toBe(0);
});
test.each(["cookies","identity"])("failed %s handoff prevents payment creation",async failure=>{
 await mount();if(failure==="cookies")navigation.mockResolvedValue(false);else session.mockResolvedValue({data:{session:{user:{id:"someone-else"}}},error:null});await click("Prepare payment");
 expect(fetchMock.mock.calls.some(([,o])=>o.method==="POST")).toBe(false);expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("sign-out while card details are tokenized prevents confirmation and stores no new request",async()=>{
 phase="needs_method";await mount();token.mockImplementationOnce(async()=>{session.mockResolvedValue({data:{session:null},error:null});return {confirmationToken:{id:"ctoken_original"}};});
 await click("Pay $33.33");expect(token).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls.some(([,o])=>o.method==="POST")).toBe(false);expect(sessionStorage.length).toBe(0);expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("an uncertain confirmation preserves its original identity and blocks new card submission",async()=>{
 await mount();await click("Prepare payment");const original=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((path,o)=>o.body&&JSON.parse(o.body).action==="confirm"?Promise.reject(Error("connection lost")):original(path,o));
 await click("Pay $33.33");const saved=JSON.parse(sessionStorage.getItem("creatornet-team-confirmation-v1:buyer:sale")!);expect(saved).toMatchObject({kind:"token",token:"ctoken_original"});
 expect(buttons().some(b=>b.textContent?.startsWith("Pay $"))).toBe(false);expect(button("Check original confirmation")).toBeDefined();expect(token).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem("creatornet-team-confirmation-v1:buyer:sale")).not.toContain("secret");
});
test("Stop remains available when new collection is disabled and never claims a refund",async()=>{
 enabled=false;await mount();expect(button("Prepare payment").disabled).toBe(true);await click("Stop this payment");expect(container.textContent).toContain("safely closed unpaid");expect(container.textContent).not.toContain("refunded");
});
test("bank action uses only the owned client secret and refreshes independent server state",async()=>{
 phase="requires_action";await mount();await click("Verify with your bank");expect(bank).toHaveBeenCalledWith({clientSecret:"pi_original_secret_owned"});
 expect(fetchMock.mock.calls.some(([,o])=>o.body&&JSON.parse(o.body).action==="refresh")).toBe(true);expect(sessionStorage.length).toBe(0);
});
test("an off-session authentication decline asks for explicit verification on the same original without a new token",async()=>{
 phase="authentication_required";await mount();expect(button("Verify saved card").disabled).toBe(false);await click("Verify saved card");expect(token).not.toHaveBeenCalled();expect(fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null)).toContainEqual({action:"reconfirm",request_id:expect.any(String)});expect(navigation).toHaveBeenCalled();
});
test("a paid plan can stop future automatic debits while retaining the existing paid purchase",async()=>{
 phase="paid";enabled=false;let stopped=false;
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>{if(options?.body&&JSON.parse(String(options.body)).action==="stop")stopped=true;return response({payment:{...view(),automaticDebitsStopped:stopped},collectionEnabled:false});});
 await mount();await click("Stop future automatic payments");expect(container.textContent).toContain("Future automatic debits are stopped");expect(container.textContent).toContain("Any remaining contractual balance requires review");expect(container.querySelector('a[href="/library"]')).not.toBeNull();
 expect(token).not.toHaveBeenCalled();
});

test("a due later payment needs an explicit buyer action and targets its saved obligation",async()=>{
 phase="paid";enabled=false;laterEnabled=true;nextPayment={status:"due",periodNumber:2,amountCents:3333};await mount();
 expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);await click("Prepare payment 2");expect(container.textContent).toContain("Payment 2 of your accepted plan");await click("Pay $33.33");
 const bodies=fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null).filter(Boolean);expect(bodies).toContainEqual({action:"prepare_next"});expect(bodies).toContainEqual({action:"confirm",request_id:expect.any(String),confirmation_token:"ctoken_original",obligation_id:"later-owned"});
});
test("later admission stays unavailable when its independent readiness is off",async()=>{
 phase="paid";nextPayment={status:"due",periodNumber:2};await mount();expect(button("Prepare payment 2").disabled).toBe(true);expect(token).not.toHaveBeenCalled();
});
test("reload retains a later uncertain confirmation's exact obligation",async()=>{
 phase="needs_method";obligationId="later-owned";periodNumber=2;await mount();const original=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((path,o)=>o.body&&JSON.parse(o.body).action==="confirm"?Promise.reject(Error("connection lost")):original(path,o));await click("Pay $33.33");
 expect(JSON.parse(sessionStorage.getItem("creatornet-team-confirmation-v1:buyer:sale")!)).toMatchObject({obligationId:"later-owned"});await act(async()=>root.unmount());root=createRoot(container);await mount();await click("Check original confirmation");
 expect(fetchMock.mock.calls.map(([,o])=>o.body?JSON.parse(o.body):null)).toContainEqual({action:"resume",request_id:expect.any(String),confirmation_token:"ctoken_original",obligation_id:"later-owned"});expect(token).toHaveBeenCalledTimes(1);
});
test("a safely canceled later payment keeps the earlier Library purchase visible",async()=>{
 phase="later_stopped";obligationId="later-owned";periodNumber=2;await mount();expect(container.textContent).toContain("earlier paid purchase remains in your Library");expect(container.textContent).not.toContain("safely closed unpaid");expect(container.querySelector('a[href="/library"]')).not.toBeNull();expect(buttons().some(b=>b.textContent==="Stop this payment")).toBe(false);
});
test("a server-admitted new retry clears only the older closed browser confirmation",async()=>{
 phase="needs_method";obligationId="new-retry";periodNumber=2;sessionStorage.setItem("creatornet-team-confirmation-v1:buyer:sale",JSON.stringify({id:"old-request",kind:"token",token:"ctoken_old",obligationId:"closed-original"}));fetchMock.mockResolvedValue(response({payment:{...view(),retryAttempt:true},collectionEnabled:true}));await mount();expect(sessionStorage.getItem("creatornet-team-confirmation-v1:buyer:sale")).toBeNull();expect(buttons().some(b=>b.textContent?.startsWith("Pay $"))).toBe(true);expect(token).not.toHaveBeenCalled();
});
test("a retry's own uncertain confirmation remains preserved on reload",async()=>{
 phase="needs_method";obligationId="same-retry";periodNumber=2;sessionStorage.setItem("creatornet-team-confirmation-v1:buyer:sale",JSON.stringify({id:"current-request",kind:"token",token:"ctoken_current",obligationId:"same-retry"}));fetchMock.mockResolvedValue(response({payment:{...view(),retryAttempt:true},collectionEnabled:true}));await mount();expect(sessionStorage.getItem("creatornet-team-confirmation-v1:buyer:sale")).toContain("current-request");expect(buttons().some(b=>b.textContent?.startsWith("Pay $"))).toBe(false);expect(button("Check original confirmation")).toBeDefined();
});
