/** @jest-environment node */
import { renderToStaticMarkup } from "react-dom/server";
import EarningsPage, { metadata } from "@/app/dashboard/earnings/page";
import type { CreatorEarningsView } from "@/lib/creatorEarningsView";

const load = jest.fn();
jest.mock("@/lib/creatorEarningsView", () => ({ HISTORY_PAGE_SIZE: 20, fetchCurrentCreatorEarningsView: (...args: unknown[]) => load(...args) }));
jest.mock("@/components/StripeConnectBanner", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));

const params = Promise.resolve({ period: "custom", tz: "America/Phoenix", start: "2026-09-01", end: "2026-09-30" });
const view: CreatorEarningsView = { totals: [], ledgerAvailable: true, paymentCount: 0, page: 1, rows: [] };
beforeEach(() => { load.mockReset().mockResolvedValue(view); });

test("empty period shows the chosen dates without implying lifetime zero", async () => {
  const html = renderToStaticMarkup(await EarningsPage({ searchParams: params }));
  expect(html).toContain("Sep 1, 2026");
  expect(html).toContain("Sep 30, 2026");
  expect(html).toContain("No tracked payments for this period");
  expect(html).toContain("Earlier sales may not appear");
  expect(html).toContain("Gross"); expect(html).toContain("Net");
  expect(html).not.toContain("$0.00");
  expect(html).not.toMatch(/12%|platform fee|processing fee|fee ledger/i);
  expect(metadata?.description).not.toMatch(/fee|processing/i);
});

test("unavailable history never substitutes cumulative net", async () => {
  load.mockResolvedValue({ ...view, ledgerAvailable: false });
  const html = renderToStaticMarkup(await EarningsPage({ searchParams: params }));
  expect(html).toContain("temporarily unavailable");
  expect(html.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).not.toContain("No tracked payments for this period");
});

test("payment rows show gross, current net and compact status with page navigation", async () => {
  load.mockResolvedValue({ ...view, totals: [{ currency: "USD", grossCents: 10000, netCents: 6784 }], paymentCount: 25,
    rows: [{ id: "sample", label: "Product sale", grossCents: 10000, currentNetCents: 6784, currency: "USD", statusLabel: "Partially refunded", createdAt: "2026-09-12T00:00:00.000Z" }] });
  const html = renderToStaticMarkup(await EarningsPage({ searchParams: params }));
  for (const value of ["Product sale", "$100.00", "$67.84", "Partially refunded", "Next", "Page 1 of 2"]) expect(html).toContain(value);
  expect(html).not.toMatch(/12%|platform fee|processing fee|refund adjustment|original creator net/i);
});

test("invalid URL parameters cannot trigger a ledger query", async () => {
  const html = renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ period: "custom", tz: "UTC", start: "2026-09-30", end: "2026-09-01" }) }));
  expect(load).not.toHaveBeenCalled();
  expect(html).toContain("Loading this period");
});

test("signed-out requests still redirect", async () => {
  load.mockResolvedValue(null);
  await expect(EarningsPage({ searchParams: params })).rejects.toThrow("redirect:/auth");
});
