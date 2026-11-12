/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const identity={userId:"member" as string|null,loading:false,session:{access_token:"verified"}};
let query="creator_id=creator";
jest.mock("@/lib/useUser",()=>({useUser:()=>identity}));
jest.mock("next/navigation",()=>({useSearchParams:()=>new URLSearchParams(query)}));
jest.mock("@/lib/actionSession",()=>({getActionSession:jest.fn()}));
import SalesTeamBankExceptions from "@/components/SalesTeamBankExceptions";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;
const state={requestId:"original",creatorId:"creator",beneficiary:"closer",transferredCents:"1000",transferredAt:"2026-10-28T00:00:00Z",reversedCents:"0",
 payoutStatus:"paid",observedAt:"2026-10-28T01:00:00Z",reason:"bank_confirmation_pending",bankConfirmed:false,outstanding:true};
const queue=()=>({creatorId:"creator",scope:"closer",membershipStatus:"removed",readAt:"2026-11-04T00:00:00Z",entries:[{state,latestReview:{reviewId:"review",action:"escalated",actorRole:"owner",reviewedAt:"2026-11-01T00:00:00Z",appliesToCurrentState:false}}],hasMore:false,nextCursor:null});
const detail=()=>({state,stateSha256:"a".repeat(64),history:[{reviewId:"review",action:"acknowledged",actorRole:"manager",reviewedAt:"2026-11-01T00:00:00Z",appliesToCurrentState:false}],hasMoreHistory:false,nextCursor:null});
const response=(data:unknown)=>({ok:true,json:async()=>data});
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});};
const render=async()=>{await act(async()=>root.render(createElement(SalesTeamBankExceptions)));await settle();};
const click=async(text:string)=>{const button=Array.from(container.querySelectorAll("button")).find(e=>e.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());await settle();};
beforeEach(()=>{
 jest.clearAllMocks();Object.assign(identity,{userId:"member",loading:false,session:{access_token:"verified"}});query="creator_id=creator";
 container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 fetchMock.mockImplementation(async(path:string)=>response(path.includes("/queue?")?queue():detail()));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("removed closer discovers own recorded paid evidence with BANK unresolved and read-only controls",async()=>{
 await render();expect(container.textContent).toContain("Only your own financial history");expect(container.textContent).toContain("Reported paid by Stripe");
 expect(container.textContent).toContain("Bank receipt unconfirmed");expect(container.textContent).toContain("Historical review");expect(container.textContent).toContain("does not check Stripe or your bank");
 await click("View review history");expect(container.textContent).toContain("Acknowledged by manager");expect(fetchMock.mock.calls.every(([,o])=>o.method==="GET")).toBe(true);
 expect(container.textContent).not.toContain("Confirm deposit");expect(container.textContent).not.toContain("original");expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer verified");
});
test("sign-out hides all records immediately and performs no further read",async()=>{
 await render();const count=fetchMock.mock.calls.length;identity.userId=null;await render();
 expect(container.textContent).toContain("Sign in to view your own financial history");expect(container.textContent).not.toContain("$10.00");expect(fetchMock).toHaveBeenCalledTimes(count);
});
test("late result for previous identity cannot populate a different account",async()=>{
 let resolve!:(value:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await render();identity.userId="other";fetchMock.mockResolvedValue(response({...queue(),entries:[]}));await render();
 await act(async()=>resolve(response(queue())));await settle();expect(container.textContent).not.toContain("$10.00");expect(container.textContent).toContain("No completed transfer originals");
});
test("creator relationship switch aborts the previous scoped request",async()=>{
 let resolve!:(value:unknown)=>void;fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await render();const signal=fetchMock.mock.calls[0][1].signal;
 query="creator_id=other";fetchMock.mockResolvedValue(response({...queue(),creatorId:"other",entries:[]}));await render();expect(signal.aborted).toBe(true);
 await act(async()=>resolve(response(queue())));await settle();expect(container.textContent).not.toContain("$10.00");expect(fetchMock.mock.calls[1][0]).toContain("creator_id=other");
});
test("queue errors remove prior history and remain retryable",async()=>{
 await render();await click("View review history");fetchMock.mockResolvedValue({ok:false,json:async()=>({error:"Access changed"})});await click("Refresh payout reviews");
 expect(container.textContent).toContain("Access changed");expect(container.textContent).not.toContain("$10.00");expect(container.querySelector('[aria-label="Selected payout review history"]')).toBeNull();
});
test("queue pagination keeps every page without duplicate originals",async()=>{
 fetchMock.mockResolvedValueOnce(response({...queue(),hasMore:true,nextCursor:"original"}));await render();
 fetchMock.mockResolvedValueOnce(response({...queue(),entries:[...queue().entries,{state:{...state,requestId:"older",transferredCents:"500"},latestReview:null}]}));await click("Load older transfers");
 expect(container.querySelectorAll("article")).toHaveLength(2);expect(container.textContent).toContain("$5.00");expect(fetchMock.mock.calls[1][0]).toContain("cursor=original");
});
test("history state changes refuse mixed pagination and require an explicit fresh read",async()=>{
 await render();fetchMock.mockResolvedValueOnce(response({...detail(),hasMoreHistory:true,nextCursor:"review"}));await click("View review history");
 fetchMock.mockResolvedValueOnce(response({...detail(),stateSha256:"b".repeat(64),history:[]}));await click("Load older reviews");
 const selected=container.querySelector('[aria-label="Selected payout review history"]')!;
 expect(selected.textContent).toContain("recorded payout state changed");expect(selected.textContent).not.toContain("Acknowledged by manager");
 fetchMock.mockResolvedValueOnce(response(detail()));await click("Refresh selected history");expect(selected.textContent).toContain("Acknowledged by manager");
});
