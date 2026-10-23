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
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;let phase:string,enabled:boolean;
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
const view=()=>({phase,amountCents:3333,currency:"usd",saveForFuture:true,pendingRequest:null,...(phase==="requires_action"?{clientSecret:"pi_original_secret_owned"}:{})});
const buttons=()=>Array.from(container.querySelectorAll("button"));const button=(text:string)=>buttons().find(b=>b.textContent?.includes(text))!;
const click=async(text:string)=>{await act(async()=>{button(text).click();await new Promise(r=>setTimeout(r,20));});};
const mount=async()=>{await act(async()=>{root.render(createElement(TeamBuyerPayment,{saleId:"sale",userId:viewer}));await new Promise(r=>setTimeout(r,20));});await act(async()=>{await new Promise(r=>setTimeout(r,20));});};
beforeEach(()=>{
 jest.clearAllMocks();viewer="buyer";phase="not_started";enabled=true;sessionStorage.clear();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 navigation.mockResolvedValue(true);session.mockImplementation(async()=>({data:{session:{user:{id:viewer}}},error:null}));submit.mockResolvedValue({});billing.mockResolvedValue({complete:true,value:{name:"Buyer",address:{country:"US",line1:"1 Main",city:"Phoenix",state:"AZ",postal_code:"85001"}}});
 token.mockResolvedValue({confirmationToken:{id:"ctoken_original"}});bank.mockResolvedValue({});
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>{const action=options?.body?JSON.parse(String(options.body)).action:null;if(action==="prepare")phase="needs_method";if(action==="confirm"||action==="reconfirm")phase="captured_pending_receipt";if(action==="stop")phase="stopped";return response({payment:view(),collectionEnabled:enabled});});
});afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("viewing an accepted review never creates a customer, intent or confirmation automatically",async()=>{
 await mount();expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(token).not.toHaveBeenCalled();expect(button("Prepare payment").disabled).toBe(false);
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
test("a paid plan can stop future automatic debits while retaining the existing paid purchase",async()=>{
 phase="paid";enabled=false;let stopped=false;
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>{if(options?.body&&JSON.parse(String(options.body)).action==="stop")stopped=true;return response({payment:{...view(),automaticDebitsStopped:stopped},collectionEnabled:false});});
 await mount();await click("Stop future automatic payments");expect(container.textContent).toContain("Future automatic debits are stopped");expect(container.textContent).toContain("Any remaining contractual balance requires review");expect(container.querySelector('a[href="/library"]')).not.toBeNull();
 expect(token).not.toHaveBeenCalled();
});
