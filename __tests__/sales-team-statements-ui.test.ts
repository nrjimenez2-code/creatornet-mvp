/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const push=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:"member",loading:false,session:{access_token:"verified"}})}));
jest.mock("next/navigation",()=>({useSearchParams:()=>new URLSearchParams("creator_id=creator"),useRouter:()=>({push})}));
import SalesTeamStatements from "@/components/SalesTeamStatements";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const mockFetch=jest.fn(),originalFetch=global.fetch;
beforeEach(()=>{
 jest.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=mockFetch;
 mockFetch.mockImplementation(async(path:string)=>({ok:true,json:async()=>path.includes("?")?{creatorId:"creator",scope:"closer",membershipStatus:"removed",currency:"usd",
  totals:{earnedCents:"1000",releasedCents:"0",reversedCents:"0",unpaidCents:"1000",recoveryCents:"0"},nextCursor:null,bankPayoutStatus:"not_recorded",
  entries:[{receiptId:"receipt",saleId:"sale",title:"Booked course",periodNumber:1,holdUntil:"2026-10-20T00:00:00Z",earnedCents:1000,unpaidCents:1000,recoveryCents:0,
   status:"settlement_paused",bankPayoutStatus:"not_recorded",creatorAccounting:null}]}:{relationships:[{creator_id:"creator",role:"closer",status:"removed"}]}}));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("removed closers retain a read-only statement without a bank-paid claim or customer controls",async()=>{
 await act(async()=>{root.render(createElement(SalesTeamStatements));await new Promise(resolve=>setTimeout(resolve,30));});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 expect(container.textContent).toContain("existing commission agreements and this statement remain available");
 expect(container.textContent).toContain("Earned: $10.00");expect(container.textContent).toContain("Automatic settlement paused");
 expect(container.textContent).toContain("bank-payout evidence is not yet recorded");expect(container.textContent).not.toContain("Creator accounting");
 expect(container.textContent).not.toContain("Invite");expect(mockFetch.mock.calls.every(([,options])=>options.method==="GET")).toBe(true);
});
test("paid, failed and reversed payout observations stay separate from confirmed bank receipt",async()=>{
 const original=mockFetch.getMockImplementation()!;
 mockFetch.mockImplementation(async(path:string)=>{const response=await original(path);const data=await response.json();if(path.includes("?")){
  data.payoutEvidenceAsOf="2026-10-29T00:00:00Z";data.entries[0].hasMorePayoutEvidence=true;
  data.entries[0].payoutEvidence=[{beneficiary:"closer",transferredCents:"1000",transferredAt:"2026-10-28T00:00:00Z",reversedCents:"200",payoutStatus:"paid",observedAt:"2026-10-28T01:00:00Z",bankConfirmed:false},
   {beneficiary:"closer",transferredCents:"500",transferredAt:"2026-10-28T02:00:00Z",reversedCents:"0",payoutStatus:"failed",observedAt:"2026-10-28T03:00:00Z",bankConfirmed:false}];
 }return {ok:true,json:async()=>data};});
 await act(async()=>{root.render(createElement(SalesTeamStatements));await new Promise(resolve=>setTimeout(resolve,30));});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 expect(container.textContent).toContain("Reported paid by Stripe");expect(container.textContent).toContain("Reported failed");
 expect(container.textContent).toContain("Bank receipt unconfirmed");expect(container.textContent).toContain("Transfer reversals recorded: $2.00");
 expect(container.textContent).toContain("does not check Stripe or your bank");expect(container.textContent).toContain("latest 20 completed transfers");
 expect(container.textContent).not.toContain("Creator transfer");expect(mockFetch.mock.calls.every(([,options])=>options.method==="GET")).toBe(true);
});
