import type {SupabaseClient} from "@supabase/supabase-js";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
const mockConfig=jest.fn(),mockObserve=jest.fn();
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>mockConfig()}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:()=>mockObserve()})}));
import {buyerMentorshipAdminReady,parseBuyerMentorshipAdminPage,readBuyerMentorshipAdminPage} from "../lib/mentorshipInstallmentAdmin";
const f=buyerFirstCaptureFixture(),context=f.context;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture(){return {context,observedAt:"2026-09-21T00:00:00Z",backlog:{pending:3,attention:1},oldestDueAt:1700000000,
  rows:[{id:id(1),request_id:id(2),context,title:"Mentorship",amount_cents:10001,payment_count:3,service_months:10,paid_count:1,
    next_payment_at:1700000000,service_end_at:1800000000,collection_hold_at:null,financial_hold_at:null,debit_revoked_at:null,
    worker_status:"review_required",next_attempt_at:null,last_attempt_at:null,lease_until:null,due_action:"review",
    recovery_invoice_id:null,recovery_payment_number:null,recovery_outcome:null,recovery_observed_at:null}]};}
const env={CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ADMIN_READY:"true",
  CREATOR_MENTORSHIP_INSTALLMENT_ADMIN_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_WORKER_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY:"true"};
beforeEach(()=>{jest.clearAllMocks();mockConfig.mockReturnValue({approvedContext:context});mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});});
test("default-off review cannot query service data",async()=>{
  const rpc=jest.fn();expect(buyerMentorshipAdminReady({})).toBe(false);
  await expect(readBuyerMentorshipAdminPage({rpc} as unknown as SupabaseClient,null,{})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();expect(mockObserve).not.toHaveBeenCalled();
});
test("reader observes exact account/project context before scoped bounded service read",async()=>{
  const rpc=jest.fn().mockResolvedValue({data:fixture(),error:null});
  expect((await readBuyerMentorshipAdminPage({rpc} as unknown as SupabaseClient,null,env)).plans).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith("read_buyer_mentorship_admin_page_v1",{p_context:context,p_after:null,p_limit:25});
});
test("wrong observed provider account prevents any billing read",async()=>{
  const rpc=jest.fn();mockObserve.mockResolvedValue({contextEvidence:{...f.contextEvidence,observedPlatformAccountId:"acct_wrong"}});
  await expect(readBuyerMentorshipAdminPage({rpc} as unknown as SupabaseClient,null,env)).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
});
test("database failure cannot become an empty queue",async()=>{
  const rpc=jest.fn().mockResolvedValue({data:null,error:{message:"private"}});
  await expect(readBuyerMentorshipAdminPage({rpc} as unknown as SupabaseClient,null,env)).rejects.toThrow("unavailable");
});
test("pagination validates lookahead and preserves global counts",()=>{
  const data=fixture();data.rows=Array.from({length:26},(_,i)=>({...data.rows[0],id:id(i+1)}));
  const result=parseBuyerMentorshipAdminPage(data,context,null);
  expect(result.plans).toHaveLength(25);expect(result.nextCursor).toBe(id(25));expect(result.pending).toBe(3);
});
test.each(["foreign context","duplicate","before cursor","bad amount","bad date","unknown outcome","oversized batch","invalid total","unpaired recovery"])("reject malformed service result: %s",kind=>{
  const data:any=fixture();let cursor:string|null=null;
  if(kind==="foreign context")data.rows[0].context={...context,mode:"live"};
  if(kind==="duplicate")data.rows.push({...data.rows[0]});
  if(kind==="before cursor")cursor=id(1);
  if(kind==="bad amount")data.rows[0].amount_cents=100.1;
  if(kind==="bad date")data.rows[0].last_attempt_at="not a date";
  if(kind==="unknown outcome")data.rows[0].worker_status="fake healthy";
  if(kind==="oversized batch")data.rows=Array.from({length:27},(_,i)=>({...data.rows[0],id:id(i+1)}));
  if(kind==="invalid total")data.backlog.attention=-1;
  if(kind==="unpaired recovery")data.rows[0].recovery_invoice_id="in_original";
  expect(()=>parseBuyerMentorshipAdminPage(data,context,cursor)).toThrow("unavailable");
});
test("projection never forwards unexpected provider or secret fields",()=>{
  const data:any=fixture();data.rows[0].proof={secret:"private"};data.rows[0].customer_id="cus_private";
  expect(JSON.stringify(parseBuyerMentorshipAdminPage(data,context,null))).not.toContain("private");
});
