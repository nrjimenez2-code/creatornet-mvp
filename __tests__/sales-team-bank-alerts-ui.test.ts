/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const identity={userId:"member" as string|null,loading:false,session:{access_token:"rendered"}};
let query="creator_id=creator";
jest.mock("@/lib/useUser",()=>({useUser:()=>identity}));
jest.mock("next/navigation",()=>({useSearchParams:()=>new URLSearchParams(query)}));
jest.mock("@/lib/actionSession",()=>({getActionSession:jest.fn()}));
import {getActionSession} from "@/lib/actionSession";
import SalesTeamBankAlerts from "@/components/SalesTeamBankAlerts";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch,session=getActionSession as jest.Mock;
const state={requestId:"original",creatorId:"creator",beneficiary:"closer",transferredCents:"1000",transferredAt:"2026-10-28T00:00:00Z",reversedCents:"0",payoutStatus:"paid",observedAt:"2026-10-28T01:00:00Z",reason:"bank_confirmation_pending",bankConfirmed:false,outstanding:true};
const history=()=>({creatorId:"creator",scope:"closer",membershipStatus:"removed",canMarkRead:true,entries:[{alertId:"alert",kind:"escalated",state,createdAt:"2026-11-04T00:00:00Z",readAt:null as string|null,appliesToCurrentState:false}],hasMore:false,nextCursor:null as string|null});
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});};
const render=async()=>{await act(async()=>root.render(createElement(SalesTeamBankAlerts)));await settle();};
const click=async(text:string)=>{const button=Array.from(container.querySelectorAll("button")).find(e=>e.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());await settle();};
beforeEach(()=>{
 jest.clearAllMocks();Object.assign(identity,{userId:"member",loading:false,session:{access_token:"rendered"}});query="creator_id=creator";
 container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 session.mockResolvedValue({data:{session:{user:{id:"member"},access_token:"fresh"}}});fetchMock.mockResolvedValue(response(history()));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("removed closer sees historical alert, unresolved BANK and no mount/remount POST",async()=>{
 await render();expect(container.textContent).toContain("Only your own financial history");expect(container.textContent).toContain("Payout review escalated");expect(container.textContent).toContain("Historical alert");expect(container.textContent).toContain("Bank receipt unconfirmed");
 expect(container.textContent).toContain("does not check Stripe or your bank");expect(container.textContent).not.toContain("original");expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(session).not.toHaveBeenCalled();
 await act(async()=>root.unmount());root=createRoot(container);await render();expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);
});
test("explicit personal read action uses fresh verified session, then fresh history, without hiding alert",async()=>{
 await render();const next=history();next.entries[0].readAt="2026-11-04T01:00:00Z";
 fetchMock.mockResolvedValueOnce(response({alertId:"alert",readAt:next.entries[0].readAt})).mockResolvedValueOnce(response(next));await click("Mark alert read");
 const post=fetchMock.mock.calls.find(([,o])=>o.method==="POST");expect(post?.[1].headers.Authorization).toBe("Bearer fresh");expect(JSON.parse(post?.[1].body)).toEqual({creator_id:"creator",alert_id:"alert"});
 expect(container.textContent).toContain("Read by you");expect(container.textContent).toContain("Payout review escalated");expect(container.textContent).toContain("payout remains outstanding");
});
test("session identity change before dispatch sends no POST and clears rendered records",async()=>{
 await render();session.mockResolvedValue({data:{session:{user:{id:"other"},access_token:"other"}}});await click("Mark alert read");
 expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);expect(container.textContent).toContain("signed-in account changed");expect(container.textContent).not.toContain("Payout review escalated");
});
test("sign-out hides rows immediately and aborted late read cannot populate another relationship",async()=>{
 let resolve!:(value:unknown)=>void;fetchMock.mockReturnValueOnce(new Promise(r=>{resolve=r;}));await render();identity.userId=null;await render();
 await act(async()=>resolve(response(history())));expect(container.textContent).toContain("Sign in");expect(container.textContent).not.toContain("Payout review escalated");
});
test("read receipt response after account switch cannot populate the new identity",async()=>{
 await render();let resolve!:(value:unknown)=>void;fetchMock.mockReturnValueOnce(new Promise(r=>{resolve=r;}));await click("Mark alert read");
 identity.userId="other";fetchMock.mockResolvedValue(response({...history(),entries:[]}));await render();await act(async()=>resolve(response({alertId:"alert",readAt:"2026-11-04T01:00:00Z"})));await settle();
 expect(container.textContent).not.toContain("Read by you");expect(fetchMock.mock.calls.filter(([,o])=>o.method==="POST")).toHaveLength(1);
});
test("changed access during older-page load rejects mixed creator/closer data",async()=>{
 const first={...history(),scope:"creator",membershipStatus:"active",hasMore:true,nextCursor:"alert"};fetchMock.mockResolvedValueOnce(response(first));await render();
 fetchMock.mockResolvedValueOnce(response({...history(),entries:[]}));await click("Load older alerts");expect(container.textContent).toContain("access changed");expect(container.textContent).not.toContain("Payout review escalated");
});
test("unknown read outcome never replays on refresh or identity remount",async()=>{
 await render();fetchMock.mockRejectedValueOnce(new Error("Lost response; refresh to reconcile"));await click("Mark alert read");expect(container.textContent).toContain("Lost response");
 fetchMock.mockResolvedValue(response(history()));await click("Refresh payout alerts");expect(fetchMock.mock.calls.filter(([,o])=>o.method==="POST")).toHaveLength(1);
});
test("held read gate keeps history visible and disables read action",async()=>{fetchMock.mockResolvedValue(response({...history(),canMarkRead:false}));await render();expect(container.textContent).toContain("Payout review escalated");expect(Array.from(container.querySelectorAll("button")).find(e=>e.textContent==="Mark alert read")?.disabled).toBe(true);});
