import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminSkeleton,
  AdminFrameSkeleton,
  AuthSkeleton,
  ClosersSkeleton,
  DashboardSkeleton,
  GoogleSetupSkeleton,
  LibrarySkeleton,
  MembershipCompleteSkeleton,
  PaymentDetailSkeleton,
  SearchPlayerFrameSkeleton,
  SearchSkeleton,
  SuccessSkeleton,
  TagSkeleton,
  WatchSkeleton,
} from "@/components/loading/Skeletons";

describe("CreatorNet loading states", () => {
  it.each([
    ["feed", createElement(DashboardSkeleton)],
    ["search", createElement(SearchSkeleton)],
    ["tag", createElement(TagSkeleton)],
    ["library", createElement(LibrarySkeleton)],
    ["watch", createElement(WatchSkeleton)],
    ["admin", createElement(AdminSkeleton)],
    ["admin frame", createElement(AdminFrameSkeleton)],
    ["auth", createElement(AuthSkeleton)],
    ["payment", createElement(PaymentDetailSkeleton)],
    ["booking dashboard", createElement(ClosersSkeleton)],
    ["calendar setup", createElement(GoogleSetupSkeleton)],
    ["membership confirmation", createElement(MembershipCompleteSkeleton)],
    ["purchase confirmation", createElement(SuccessSkeleton)],
    ["search player", createElement(SearchPlayerFrameSkeleton)],
  ])("gives the %s skeleton a status and decorative shapes", (_name, element) => {
    const html = renderToStaticMarkup(element);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("cn-skeleton");
  });

  it("keeps the current feed frame and tile geometry", () => {
    expect(renderToStaticMarkup(createElement(DashboardSkeleton))).toContain("lg:w-[420px]");
    expect(renderToStaticMarkup(createElement(DashboardSkeleton))).toContain("lg:-translate-x-28");
    expect(renderToStaticMarkup(createElement(TagSkeleton))).toContain("aspect-square");
    expect(renderToStaticMarkup(createElement(LibrarySkeleton))).toContain("aspect-[4/3]");
  });

  it("uses the light surface only where the current page is light", () => {
    expect(renderToStaticMarkup(createElement(AdminSkeleton))).toContain("cn-skeleton--light");
    expect(renderToStaticMarkup(createElement(AuthSkeleton))).toContain("cn-skeleton--light");
    expect(renderToStaticMarkup(createElement(DashboardSkeleton))).toContain("cn-skeleton--dark");
  });

  it("stops the pulse for reduced-motion users", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.cn-skeleton\s*\{\s*animation:\s*none/);
  });

  it.each([
    "admin", "admin/users", "admin/content", "admin/reviews", "admin/commerce", "admin/commerce/installments",
    "auth", "onboarding", "dashboard", "dashboard/analytics", "dashboard/closers", "dashboard/earnings",
    "search", "tag/[hashtag]", "creators/[creatorId]", "creators/[creatorId]/reviews", "profile", "profile/edit",
    "library", "continue", "watch/[postId]", "calls", "payments", "payments/recovery/[agreementId]",
    "memberships", "memberships/review", "memberships/complete", "memberships/payoff", "memberships/recovery",
    "memberships/renewal-recovery", "memberships/renewal-retry", "purchase/review", "success", "access/[purchaseId]",
    "scheduling/book/[connection]", "scheduling/google", "scheduling/connect", "scheduling/complete",
  ])("has a route fallback for %s", route => {
    expect(existsSync(join(process.cwd(), "app", route, "loading.tsx"))).toBe(true);
  });
});
