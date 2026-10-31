/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const navigation=jest.fn(),session=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:"buyer",session:{access_token:"verified-session"},loading:false})}));
jest.mock("@/lib/browserSession",()=>({prepareSessionNavigation:()=>navigation()}));
jest.mock("@/lib/supabaseClient",()=>({createClient:()=>({auth:{getSession:session}})}));
import TeamBuyerLifecycle from "@/components/TeamBuyerLifecycle";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement,enabled:boolean;const fetchMock=jest.fn(),onPayment=jest.fn(),originalFetch=global.fetch;
const q={version:"creatornet-team-exit-v1",saleId:"sale",fingerprint:"a".repeat(64),paymentKind:"monthly",coveredPeriods:1,minimumMonths:3,remainingMonths:2,payoffAmountCents:20002,minimumEnd:"2027-01-26T10:00:00Z",automaticDebitsStopped:false,renewalStopped:false,canAcceptPayoff:true,reviewReasons:[],payoff:null,authorization:"A payoff is separate from debit permission. Failed attempts do not count as paid."};
const button=(text:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent?.includes(text))!;
const click=async(text:string)=>{await act(async()=>{button(text).click();await new Promise(r=>setTimeout(r,20));});};
const mount=async()=>{await act(async()=>{root.render(createElement(TeamBuyerLifecycle,{saleId:"sale",userId:"buyer",onPayment}));await new Promise(r=>setTimeout(r,20));});};
beforeEach(()=>{
 jest.clearAllMocks();enabled=true;container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 navigation.mockResolvedValue(true);session.mockResolvedValue({data:{session:{user:{id:"buyer"}}},error:null});
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>({ok:true,json:async()=>options?.body?{quote:q,payment:{phase:"needs_method",amountCents:20002,saveForFuture:false,pendingRequest:null},collectionEnabled:enabled,lifecycleAvailable:true}:{quote:q,payoffCollectionEnabled:enabled}}));
});afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("a payoff quote never accepts terms or starts payment on mount",async()=>{
 await mount();expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(button("Prepare one-time payoff").disabled).toBe(true);expect(container.textContent).toContain("$200.02");expect(container.textContent).toContain("remaining 2 month");expect(onPayment).not.toHaveBeenCalled();
 expect(session).not.toHaveBeenCalled();expect(navigation).not.toHaveBeenCalled();
});
test("separate checkbox consent sends only the exact quote fingerprint and request identity",async()=>{
 await mount();await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("Prepare one-time payoff");
 const body=JSON.parse(fetchMock.mock.calls.find(([,o])=>o.method==="POST")![1].body);expect(body).toEqual({action:"prepare_payoff",request_id:expect.any(String),accepted:true,fingerprint:q.fingerprint});expect(onPayment).toHaveBeenCalledWith(expect.objectContaining({payment:expect.objectContaining({saveForFuture:false,amountCents:20002})}));
});
test("debit Stop and minimum renewal Stop remain available while payoff collection is held",async()=>{
 enabled=false;await mount();expect(button("Prepare one-time payoff").disabled).toBe(true);await click("Stop future automatic debits");await click("Stop renewal after the minimum");
 expect(fetchMock.mock.calls.filter(([,o])=>o.method==="POST").map(([,o])=>JSON.parse(o.body).action)).toEqual(["revoke_debits","stop_renewal"]);expect(container.textContent).not.toContain("balance waived");
});
test.each(["identity","signed_out","error"])("%s session prevents a payoff or exit request",async fault=>{
 await mount();session.mockResolvedValue({data:{session:fault==="signed_out"?null:{user:{id:fault==="identity"?"different-buyer":"buyer"}}},error:fault==="error"?Error("Session unavailable"):null});await click("Stop future automatic debits");expect(fetchMock.mock.calls.some(([,o])=>o.method==="POST")).toBe(false);expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("an existing accepted payoff opens its original payment without another acceptance",async()=>{
 fetchMock.mockResolvedValue({ok:true,json:async()=>({quote:{...q,canAcceptPayoff:false,payoff:{id:"original",obligationId:"obligation",completed:false}},payoffCollectionEnabled:false,payment:{phase:"stop_pending"},collectionEnabled:false})});await mount();await click("View original payoff");
 expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(fetchMock.mock.calls.some(([path])=>path.endsWith("/payment"))).toBe(true);expect(onPayment).toHaveBeenCalled();
});
