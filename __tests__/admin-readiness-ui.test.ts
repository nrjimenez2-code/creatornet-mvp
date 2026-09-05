/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { paymentModeFromKey, operatorInitials } from "@/lib/admin/display-context";
import type { AdminOrder } from "@/types/admin";

let orders: AdminOrder[] = [];
const router = { refresh: jest.fn() };
jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/commerce",
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: never }) => createElement("a", { href, ...props }, children),
}));
jest.mock("@/components/admin/AdminDataContext", () => ({
  useAdminData: () => ({ stats: { flaggedCount: 0 }, orders, bookings: [] }),
}));
jest.mock("@/components/admin/Toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));
jest.mock("@/components/admin/CommandPalette", () => ({ OPEN_PALETTE_EVENT: "test-palette" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  orders = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test.each([
  ["sk_test_placeholder", "test"], ["rk_test_placeholder", "test"],
  ["sk_live_placeholder", "live"], ["rk_live_placeholder", "live"],
  [undefined, "unknown"], ["not-a-key", "unknown"],
])("only derives a mode from the known key prefix: %s", (key, mode) => {
  expect(paymentModeFromKey(key)).toBe(mode);
});
test("operator initials have no hardcoded identity", () => {
  expect(operatorInitials("Noah Jimenez")).toBe("NJ");
  expect(operatorInitials(" ")).toBe("A");
});

test.each(["test", "live", "unknown"] as const)("sidebar honestly displays %s payment mode and authenticated operator", async (paymentMode) => {
  const { AdminSidebar } = await import("@/components/admin/AdminSidebar");
  await act(async () => root.render(createElement(AdminSidebar, { paymentMode, operatorName: "QA Operator" })));
  expect(container.textContent).toContain("QA Operator");
  expect(container.textContent).not.toContain("Landon Thomas");
  expect(container.textContent).not.toContain("session-only actions");
  expect(container.textContent).toContain(paymentMode === "unknown" ? "Payment mode unverified" : `Stripe ${paymentMode} mode`);
});

test("empty commerce state does not invent a webhook failure", async () => {
  const { CommercePageClient } = await import("@/app/admin/commerce/CommercePageClient");
  await act(async () => root.render(createElement(CommercePageClient)));
  expect(container.textContent).toContain("No payment records to display.");
  expect(container.textContent).not.toContain("webhook has never fired");
  expect(container.textContent).not.toContain("webhook is fixed");
});

test("pending webhook confirmation is explicit even after allocation completes", async () => {
  orders = [{
    id: "order-one", buyerUserId: "buyer", buyerUsername: "buyer", creatorId: "creator", creatorUsername: "creator",
    postId: "post", offerTitle: "QA Course", kind: "product", grossCents: 10000, feeCents: 1200,
    processingFeeCents: 320, creatorCents: 8480, status: "paid", createdAt: "2026-09-04T12:00:00Z",
    refundedCents: 0, remainingRefundableCents: 7500, refundEligible: true,
    latestRefund: {
      id: "refund-one", status: "completed", reasonCode: "creator_discretionary", responsibility: "creator",
      customerRefundCents: 2500, creatorBalanceImpactCents: 2200, platformFeeRefundCents: 300,
      processingFeeAllocationCents: 80, remainingRefundableCents: 7500, connectedBalanceNegative: false,
      webhookConfirmed: false, createdAt: "2026-09-04T12:00:00Z",
    },
  }];
  const { CommercePageClient } = await import("@/app/admin/commerce/CommercePageClient");
  await act(async () => root.render(createElement(CommercePageClient)));
  expect(container.textContent).toContain("Awaiting payment update. Totals and access may not yet reflect this refund.");
  orders = [{ ...orders[0], latestRefund: { ...orders[0].latestRefund!, webhookConfirmed: true } }];
  await act(async () => root.render(createElement(CommercePageClient)));
  expect(container.textContent).not.toContain("Awaiting payment update.");
});

test("commerce load failure exposes reload, not refund controls or internal auth errors", async () => {
  const reset = jest.fn();
  const { default: CommerceError } = await import("@/app/admin/commerce/error");
  await act(async () => root.render(createElement(CommerceError, { reset, error: new Error("JWT issued at future") })));
  expect(container.textContent).toContain("Commerce is temporarily unavailable");
  expect(container.textContent).not.toContain("JWT");
  const buttons = container.querySelectorAll("button");
  expect(buttons).toHaveLength(1);
  await act(async () => buttons[0].click());
  expect(reset).toHaveBeenCalledTimes(1);
});
