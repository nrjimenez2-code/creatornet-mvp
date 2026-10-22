/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let viewer:string|null="closer";
const mockNavigation=jest.fn(),mockSession=jest.fn();
jest.mock("@/lib/browserSession",()=>({prepareSessionNavigation:(...args:unknown[])=>mockNavigation(...args)}));
jest.mock("@/lib/supabaseClient",()=>({createClient:()=>({auth:{getSession:mockSession}})}));
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:viewer,session:{access_token:`${viewer}-session`},loading:false})}));
import SalesTeamPayouts from "@/components/SalesTeamPayouts";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement,enabled:boolean,link:object|null;
const fetchMock=jest.fn(),originalFetch=global.fetch;
const recipient={status:"setup_required",transfersActive:true,payoutsReady:false,verifiedAt:"2026-10-22T00:00:00Z"};
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
async function mount(){await act(async()=>{root.render(createElement(SalesTeamPayouts));await new Promise(resolve=>setTimeout(resolve,25));});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});}
const button=(label:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent===label)!;
beforeEach(()=>{
 viewer="closer";enabled=true;link=null;jest.clearAllMocks();sessionStorage.clear();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 mockNavigation.mockResolvedValue(true);mockSession.mockImplementation(async()=>({data:{session:{user:{id:viewer}}},error:null}));
 fetchMock.mockImplementation(async(_path:string,options?:RequestInit)=>options?.method==="POST"?response({recipient}):response({recipient,onboarding:link,onboardingEnabled:enabled}));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("loading payout setup only reads eligibility and separates transfers from bank delivery",async()=>{
 await mount();expect(fetchMock.mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
 expect(container.textContent).toContain("Transfers: eligible · Bank payouts: held");expect(container.textContent).toContain("does not confirm a bank deposit");expect(container.textContent).not.toContain("acct_");
});
test("paused onboarding preserves independent current-account verification",async()=>{
 enabled=false;await mount();expect(button("Continue payout setup with Stripe").disabled).toBe(true);expect(button("Refresh verification").disabled).toBe(false);
 await act(async()=>{button("Refresh verification").click();});
 expect(JSON.parse(fetchMock.mock.calls.find(([,options])=>options?.method==="POST")![1].body)).toEqual({action:"refresh"});
});
test("an uncertain setup request retains its identity across retries",async()=>{
 await mount();fetchMock.mockImplementationOnce(async()=>response({error:"Original setup needs reconciliation"},false));
 await act(async()=>{button("Continue payout setup with Stripe").click();});expect(container.querySelector('[role="alert"]')?.textContent).toContain("reconciliation");
 await act(async()=>{button("Continue payout setup with Stripe").click();});
 const calls=fetchMock.mock.calls.filter(([,options])=>options?.method==="POST").map(([,options])=>JSON.parse(options.body));
 expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(Object.keys(calls[0]).sort()).toEqual(["action","request_id"]);expect(calls[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
});
test.each(["cookies","identity"])("failed %s handoff prevents provider setup requests",async fault=>{
 await mount();if(fault==="cookies")mockNavigation.mockResolvedValue(false);
 else mockSession.mockResolvedValue({data:{session:{user:{id:"someone-else"}}},error:null});
 await act(async()=>{button("Continue payout setup with Stripe").click();});
 expect(fetchMock.mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
 expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("an expired conclusively bound link permits a fresh link request",async()=>{
 const previous="00000000-0000-4000-8000-000000000099";link={id:previous,status:"bound",expires_at:"2000-01-01T00:00:00Z"};sessionStorage.setItem("creatornet-team-onboarding:closer",previous);
 await mount();await act(async()=>{button("Continue payout setup with Stripe").click();});
 const call=fetchMock.mock.calls.find(([,options])=>options?.method==="POST")!;expect(JSON.parse(call[1].body).request_id).not.toBe(previous);
});
test("switching logins hides the previous identity immediately and ignores its pending response",async()=>{
 await mount();let resolve:(value:unknown)=>void=()=>{};fetchMock.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 await act(async()=>{button("Refresh verification").click();});viewer=null;await mount();expect(container.textContent).toContain("Sign in with your own CreatorNet login");
 await act(async()=>{resolve(response({recipient:{...recipient,status:"ready",payoutsReady:true}}));});
 expect(container.textContent).not.toContain("Account eligibility");
});
