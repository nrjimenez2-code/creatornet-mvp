import {renderToStaticMarkup} from "react-dom/server";
const mockAdmin=jest.fn(),mockReady=jest.fn(),mockRead=jest.fn();
jest.mock("@/lib/admin/server",()=>({requireAdmin:()=>mockAdmin()}));
jest.mock("@/lib/fullRefundReviewAdmin",()=>({...jest.requireActual("@/lib/fullRefundReviewAdmin"),fullRefundReviewAdminReady:()=>mockReady(),readFullRefundReviewAdmin:(...args:unknown[])=>mockRead(...args)}));
jest.mock("next/navigation",()=>({notFound:()=>{throw Error("not found");}}));
import Page from "../app/admin/commerce/full-refunds/page";
const page=()=>({mode:"test",observedAt:"2026-09-23T06:00:00Z",events:3,needsReview:1,unapplied:1,reviewRecorded:1,oldestObservedAt:null,rows:[],nextCursor:null});
beforeEach(()=>{jest.clearAllMocks();mockAdmin.mockResolvedValue({admin:{}});mockReady.mockReturnValue(true);mockRead.mockResolvedValue(page());});
test.each(["Not signed in","Admin role required"])("%s prevents data reads",async message=>{
  mockAdmin.mockRejectedValue(Error(message));await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow(message);expect(mockRead).not.toHaveBeenCalled();
});
test("disabled gate prevents data reads",async()=>{
  mockReady.mockReturnValue(false);await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow("not found");expect(mockRead).not.toHaveBeenCalled();
});
test.each(["bad",["evt_A","evt_B"]])("invalid cursor %p prevents data reads",async after=>{
  await expect(Page({searchParams:Promise.resolve({after})})).rejects.toThrow("not found");expect(mockRead).not.toHaveBeenCalled();
});
test("unavailable data is not an empty queue and does not leak errors",async()=>{
  mockRead.mockRejectedValue(Error("private"));const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
  expect(html).toContain("does not mean the queue is empty");expect(html).not.toContain("private");expect(html).not.toContain("No refund events");
});
test("later empty page preserves global counts and unresolved hold warning without mutation controls",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({after:"evt_Z"})}));
  for(const text of ["1 original payments needing review","3 saved refund events","Financial holds remain active","does not resolve a case","First page"])expect(html).toContain(text);
  expect(html).not.toContain("<button");expect(html).not.toContain("<form");
});
