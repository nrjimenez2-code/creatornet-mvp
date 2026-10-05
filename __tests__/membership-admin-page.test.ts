import { renderToStaticMarkup } from "react-dom/server";
const mockRequireAdmin = jest.fn(), mockRead = jest.fn(), mockReady = jest.fn(), mockBacklog = jest.fn();
jest.mock("@/lib/membershipBillingBacklog", () => ({ readMembershipBillingBacklog: (...args: unknown[]) => mockBacklog(...args) }));
jest.mock("@/lib/admin/server", () => ({ requireAdmin: () => mockRequireAdmin() }));
jest.mock("@/lib/membershipAdmin", () => ({
  ...jest.requireActual("@/lib/membershipAdmin"), membershipAdminReady: () => mockReady(),
  readMembershipAdminPage: (...args: unknown[]) => mockRead(...args),
}));
jest.mock("next/navigation", () => ({ notFound: () => { throw Error("not found"); } }));
import MembershipReviewPage from "@/app/admin/commerce/memberships/page";
beforeEach(() => {
  jest.clearAllMocks(); mockReady.mockReturnValue(true); mockRequireAdmin.mockResolvedValue({ admin: {} });
  mockBacklog.mockResolvedValue(null);
  mockRead.mockResolvedValue({ mode: "test", observedAt: "2026-09-21T00:00:00Z", memberships: [], nextCursor: null });
});
test.each(["Not signed in", "Admin role required"])("%s cannot read monthly finance data", async message => {
  mockRequireAdmin.mockRejectedValueOnce(Error(message));
  await expect(MembershipReviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(message);
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockBacklog).not.toHaveBeenCalled();
});

test("a configured global backlog remains visible on an empty later page", async () => {
  mockBacklog.mockResolvedValue({ observedAt: "2026-09-21T00:00:00Z", agreementCount: 30, billingDueCount: 29,
    billingOldestDueAt: "2026-09-20T00:00:00Z", exitCount: 2, exitDueCount: 1, exitOldestDueAt: "2026-09-20T12:00:00Z",
    billingReviewCount: 1, financialHoldCount: 0, billingRetryCount: 1, billingLeasedCount: 0,
    exitReviewCount: 0, exitRetryCount: 1, exitLeasedCount: 0 });
  const html = renderToStaticMarkup(await MembershipReviewPage({ searchParams: Promise.resolve({ after: "10000000-0000-4000-8000-000000000001" }) }));
  expect(html).toContain("Billing backlog across all pages"); expect(html).toContain("30 agreements");
  expect(html).toContain("29 · Oldest due"); expect(html).toContain("No monthly agreements on this page");
});
test("a failed aggregate remains visibly unavailable while the page records survive", async () => {
  mockBacklog.mockRejectedValue(Error("private database detail"));
  const html = renderToStaticMarkup(await MembershipReviewPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("Billing backlog totals could not be loaded");
  expect(html).toContain("No monthly agreements on this page"); expect(html).not.toContain("private database detail");
});
test("an unapplied backlog schema is distinguished from zero due work", async () => {
  const html = renderToStaticMarkup(await MembershipReviewPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("Billing backlog totals are not configured");
  expect(html).not.toContain("Oldest due");
});
test("disabled review is not exposed even to an admin", async () => {
  mockReady.mockReturnValue(false);
  await expect(MembershipReviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("not found");
  expect(mockRead).not.toHaveBeenCalled();
});
test.each([{ after: "bad" }, { after: ["first", "second"] }])("invalid pagination does not reach the service client", async search => {
  await expect(MembershipReviewPage({ searchParams: Promise.resolve(search) })).rejects.toThrow("not found");
  expect(mockRead).not.toHaveBeenCalled();
});
