import {renderToStaticMarkup} from "react-dom/server";
const mockAdmin=jest.fn(),mockReady=jest.fn(),mockRead=jest.fn();
jest.mock("@/lib/admin/server",()=>({requireAdmin:()=>mockAdmin()}));
jest.mock("@/lib/mentorshipInstallmentAdmin",()=>({buyerMentorshipAdminReady:()=>mockReady(),readBuyerMentorshipAdminPage:(...args:unknown[])=>mockRead(...args)}));
jest.mock("next/navigation",()=>({notFound:()=>{throw Error("not found");}}));
import Page from "../app/admin/commerce/buyer-installments/page";
const requestId="10000000-0000-4000-8000-000000000001";
const page=()=>({mode:"test",observedAt:"2026-09-21T00:00:00Z",pending:3,attention:1,oldestDueAt:1700000000,nextCursor:null,plans:[]});
beforeEach(()=>{jest.clearAllMocks();mockAdmin.mockResolvedValue({admin:{}});mockReady.mockReturnValue(true);mockRead.mockResolvedValue(page());});
test.each(["Not signed in","Admin role required"])("%s prevents service reads",async message=>{
  mockAdmin.mockRejectedValue(Error(message));await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow(message);expect(mockRead).not.toHaveBeenCalled();
});
test("disabled page remains inaccessible to admin",async()=>{
  mockReady.mockReturnValue(false);await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow("not found");expect(mockRead).not.toHaveBeenCalled();
});
test.each(["bad",[requestId,requestId]])("invalid pagination %p never reaches service read",async after=>{
  await expect(Page({searchParams:Promise.resolve({after})})).rejects.toThrow("not found");expect(mockRead).not.toHaveBeenCalled();
});
test("empty later page preserves cross-page attention and return navigation",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({after:requestId})}));
  expect(html).toContain("3 plans with due collection");expect(html).toContain("1 plans needing attention");
  expect(html).toContain("No buyer installment plans on this page");expect(html).toContain("First page");
});
test("unavailable data is not an empty queue or leaked provider error",async()=>{
  mockRead.mockRejectedValue(Error("secret provider error"));const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
  expect(html).toContain("This does not mean the queue is empty");expect(html).not.toContain("secret");expect(html).not.toContain("No buyer installment plans");
});
test("saved totals, independent service duration, revoked debit and original recovery remain distinct with no charge controls",async()=>{
  mockRead.mockResolvedValue({...page(),plans:[{id:requestId,requestId,title:"Mentorship <script>",amountCents:10001,paymentCount:3,paidCount:1,serviceMonths:36,
    serviceEndAt:1800000000,nextPaymentAt:1700000000,holds:["Automatic debits revoked"],workerStatus:"review_required",nextAttemptAt:null,lastAttemptAt:null,leaseUntil:null,
    dueAction:"recover",recoveryInvoice:"in_original",recoveryNumber:2,recoveryOutcome:"action_required",recoveryObservedAt:null}],nextCursor:requestId});
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
  for(const expected of ["$100.01 USD agreed total","1 of 3 payments accounted","36 months","Automatic debits revoked","Original invoice in_original","action required","Next page","Mentorship &lt;script&gt;"])expect(html).toContain(expected);
  expect(html).not.toContain("<button");expect(html).not.toContain("<form");expect(html).not.toContain("<script>");
});
