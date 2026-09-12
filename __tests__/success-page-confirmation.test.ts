/** @jest-environment jsdom */
/** Behavioral confirmation checks only. All fetches are mocked; timers are fake.
 * No Stripe, database, real credentials, or hosted application is contacted. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockSearch = "";
let mockAuth: { session: { access_token: string } | null; loading: boolean };
const router = { replace: jest.fn(), push: jest.fn() };

jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("@/lib/useUser", () => ({ useUser: () => mockAuth }));

import SuccessPage from "@/app/success/page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
let mockFetch: FetchMock;
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
const originalFetch = globalThis.fetch;
const course = {
  id: "synthetic-product", title: "Synthetic course", type: "course",
  discord_invite_url: "https://discord.example.invalid/synthetic",
  whop_listing_url: "https://whop.example.invalid/synthetic",
};
const paidBody = { ok: true, status: "paid", session_id: "cs_test_current" };

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: jest.fn().mockResolvedValue(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function locationFor(search: string) {
  mockSearch = search;
  window.history.replaceState(null, "", `/success${search ? `?${search}` : ""}`);
}

async function render() {
  await act(async () => { root.render(createElement(SuccessPage)); });
}

async function advance(ms: number) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

async function unmount() {
  if (!mounted) return;
  await act(async () => { root.unmount(); });
  mounted = false;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
}

function expectLocked() {
  expect(container.querySelector("h1")?.textContent).not.toBe("Success");
  expect(container.textContent).not.toMatch(/Payment confirmed!|Video unlocked!|Access ready!/);
  expect(container.querySelector(`a[href="${course.discord_invite_url}"]`)).toBeNull();
  expect(container.querySelector(`a[href="${course.whop_listing_url}"]`)).toBeNull();
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
}

function expectConfirmationRequestsOnly() {
  for (const [url, init] of mockFetch.mock.calls) {
    expect(String(url)).toBe(`${window.location.origin}/api/confirm-purchase`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({ session_id: "cs_test_current" });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAuth = { session: null, loading: false };
  mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
  globalThis.fetch = mockFetch;
  locationFor("session_id=cs_test_current");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(async () => {
  await unmount();
  container.remove();
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("purchase confirmation admission", () => {
  test.each([
    [202, { ok: true, status: "pending", purchase_id: "synthetic-purchase" }],
    [202, { ok: true, status: "pending", post_id: "synthetic-post", product: course }],
    [200, { ok: true, status: "pending", purchase_id: "synthetic-purchase", post_id: "synthetic-post", product: course }],
    [202, { ...paidBody, purchase_id: "synthetic-purchase", post_id: "synthetic-post", product: course }],
  ])("HTTP %s pending admission never unlocks IDs or fulfillment (%#)", async (status, body) => {
    mockFetch.mockResolvedValue(response(status as number, body));
    await render();
    await advance(700);
    expectLocked();
    expect(container.textContent).toContain("Waiting for payment confirmation");
    expect(container.textContent).toContain("Please don't pay again");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expectConfirmationRequestsOnly();
  });

  test("pending becomes fulfillment only after an explicit HTTP 200 paid response", async () => {
    mockFetch.mockResolvedValueOnce(response(202, { ok: true, status: "pending", product: course }))
      .mockResolvedValueOnce(response(200, { ...paidBody, product: course }));
    await render();
    expectLocked();
    await advance(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector("h1")?.textContent).toBe("Success");
    const discord = container.querySelector<HTMLAnchorElement>(`a[href="${course.discord_invite_url}"]`);
    expect(discord?.textContent).toContain("Join Discord");
    expect(discord?.rel).toBe("noopener noreferrer");
    expect(container.querySelector(`a[href="${course.whop_listing_url}"]`)).not.toBeNull();
    await advance(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...paidBody, product: { ...course, type: "video", discord_invite_url: null, whop_listing_url: null }, post_id: "synthetic-post" }, "/library"],
    [{ ...paidBody, post_id: "synthetic-post" }, "/library"],
    [{ ...paidBody, purchase_id: "synthetic-purchase" }, "/access/synthetic-purchase"],
    [paidBody, "/library"],
  ])("valid paid response preserves the existing redirect (%#)", async (body, target) => {
    mockFetch.mockResolvedValue(response(200, body));
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Success");
    expect(router.replace).not.toHaveBeenCalled();
    await advance(700);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(target);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    [200, null],
    [200, { ...paidBody, ok: false, product: course }],
    [200, { ok: true, purchase_id: "synthetic-purchase", product: course }],
    [201, { ...paidBody, product: course }],
    [204, null],
    [500, { error: "Synthetic temporary outage", product: course }],
    [429, { error: "Synthetic rate limit" }],
  ])("HTTP %s unknown or retryable result remains unconfirmed (%#)", async (status, body) => {
    mockFetch.mockResolvedValue(response(status as number, body));
    await render();
    expectLocked();
    expect(container.textContent).toContain("Please don't pay again");
    await advance(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expectLocked();
  });

  test.each([401, 403, 409])("HTTP %s preserves the real error and stops automatic checks", async (status) => {
    const message = `Synthetic actionable error ${status}`;
    mockFetch.mockResolvedValue(response(status, { error: message }));
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Heads up");
    expect(container.textContent).toContain(message);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    await advance(120_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(button("Check status")).toBeUndefined();
    expectLocked();
  });

  test.each(["network", "invalid-json"])("%s failures never claim a successful or failed payment", async (failure) => {
    if (failure === "network") mockFetch.mockRejectedValue(new TypeError("Synthetic network failure"));
    else {
      const invalid = response(200, null);
      invalid.json = jest.fn().mockRejectedValue(new SyntaxError("Synthetic invalid JSON"));
      mockFetch.mockResolvedValue(invalid);
    }
    await render();
    expectLocked();
    expect(container.textContent).toContain("Please don't pay again");
    expect(container.textContent).not.toContain("payment failed");
    expect(container.textContent).not.toContain("Synthetic");
  });
});

describe("bounded and cancellable status checks", () => {
  test("stops after twelve checks, then a double-click starts only one manual check", async () => {
    mockFetch.mockResolvedValue(response(202, { ok: true, status: "pending" }));
    await render();
    await advance(65_000);
    expect(mockFetch).toHaveBeenCalledTimes(12);
    expect(container.querySelector("h1")?.textContent).toBe("Confirmation pending");
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expectLocked();
    await advance(120_000);
    expect(mockFetch).toHaveBeenCalledTimes(12);
    const check = button("Check status");
    expect(check).toBeDefined();
    const manual = deferred<Response>();
    mockFetch.mockImplementationOnce(() => manual.promise);
    await act(async () => { check!.click(); check!.click(); });
    expect(mockFetch).toHaveBeenCalledTimes(13);
    expect(button("Check status")).toBeUndefined();
    expect(container.querySelector("h1")?.textContent).toBe("Almost there...");
    expectConfirmationRequestsOnly();
    await act(async () => { manual.resolve(response(200, { ...paidBody, purchase_id: "synthetic-purchase" })); });
    await advance(700);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/access/synthetic-purchase");
    expect(mockFetch).toHaveBeenCalledTimes(13);
  });

  test("a request is aborted after fifteen seconds and retry waits for its delay", async () => {
    let firstSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      firstSignal = init?.signal as AbortSignal;
      firstSignal.addEventListener("abort", () => reject(new DOMException("Synthetic abort", "AbortError")), { once: true });
    })).mockResolvedValue(response(202, { ok: true, status: "pending" }));
    await render();
    await advance(14_999);
    expect(firstSignal?.aborted).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(firstSignal?.aborted).toBe(true);
    expectLocked();
    expect(container.textContent).toContain("Waiting for payment confirmation");
    await advance(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("a timed-out request cannot unlock fulfillment if its late paid response ignores abort", async () => {
    const late = deferred<Response>();
    mockFetch.mockImplementationOnce(() => late.promise)
      .mockResolvedValue(response(202, { ok: true, status: "pending" }));
    await render();
    const signal = mockFetch.mock.calls[0][1]?.signal;
    await advance(15_000);
    expect(signal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => { late.resolve(response(200, {
      ...paidBody, purchase_id: "late-purchase", post_id: "late-post", product: course,
    })); });
    expectLocked();
    expect(container.textContent).toContain("Waiting for payment confirmation");
    await advance(700);
    expectLocked();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(300);
    expectLocked();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expectConfirmationRequestsOnly();
  });

  test("unmount aborts an in-flight request and ignores a late paid response", async () => {
    const delayed = deferred<Response>();
    mockFetch.mockImplementation(() => delayed.promise);
    await render();
    const signal = mockFetch.mock.calls[0][1]?.signal;
    await unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { delayed.resolve(response(200, { ...paidBody, purchase_id: "stale-purchase", product: course })); });
    await advance(120_000);
    expect(router.replace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["poll-delay", "paid-redirect"])("unmount cancels a queued %s timer", async (phase) => {
    mockFetch.mockResolvedValue(response(phase === "poll-delay" ? 202 : 200,
      phase === "poll-delay" ? { ok: true, status: "pending" } : paidBody));
    await render();
    await unmount();
    await advance(120_000);
    expect(router.replace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("changing session aborts the old request and cannot display its late fulfillment", async () => {
    const old = deferred<Response>();
    mockFetch.mockImplementationOnce(() => old.promise)
      .mockResolvedValue(response(202, { ok: true, status: "pending" }));
    await render();
    const oldSignal = mockFetch.mock.calls[0][1]?.signal;
    locationFor("session_id=cs_test_new");
    await render();
    expect(oldSignal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ session_id: "cs_test_new" });
    await act(async () => { old.resolve(response(200, { ...paidBody, product: course })); });
    await advance(700);
    expectLocked();
    expect(container.textContent).toContain("Waiting for payment confirmation");
  });

  test("changing session removes already displayed fulfillment and starts a fresh check", async () => {
    mockFetch.mockResolvedValueOnce(response(200, { ...paidBody, product: course }))
      .mockResolvedValue(response(202, { ok: true, status: "pending" }));
    await render();
    expect(container.querySelector(`a[href="${course.discord_invite_url}"]`)).not.toBeNull();
    locationFor("session_id=cs_test_new");
    await render();
    expectLocked();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("separate booking setup contract", () => {
  test("a valid setup response needs no paid status and waits for authenticated seeding", async () => {
    locationFor("session_id=cs_test_booking&kind=booking");
    mockAuth = { session: { access_token: "synthetic-old-token" }, loading: false };
    const confirmation = deferred<Response>();
    const seeded = deferred<Response>();
    mockFetch.mockImplementationOnce(() => confirmation.promise).mockImplementationOnce(() => seeded.promise);
    await render();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(button("Confirming your booking...")?.disabled).toBe(true);
    mockAuth = { session: { access_token: "synthetic-refreshed-token" }, loading: false };
    await render();
    await act(async () => { confirmation.resolve(response(200, {
      ok: true, kind: "booking", post_id: "synthetic-post", booking_redirect_url: null,
    })); });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toBe(`${window.location.origin}/api/bookings/seed`);
    expect(mockFetch.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-refreshed-token" });
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ post_id: "synthetic-post" });
    expect(container.textContent).toContain("Creating booking record");
    expect(container.querySelector("h1")?.textContent).not.toBe("Success");
    await act(async () => { seeded.resolve(response(200, { ok: true, booking_id: "synthetic-booking" })); });
    expect(container.textContent).toContain("Booking confirmed.");
    expect(container.querySelector("h1")?.textContent).toBe("Success");
    expect(button("Book")).toBeDefined();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    await advance(120_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("booking seed failure preserves its error without stuck processing or redirect", async () => {
    locationFor("session_id=cs_test_booking&kind=booking");
    mockAuth = { session: { access_token: "synthetic-booking-token" }, loading: false };
    mockFetch.mockResolvedValueOnce(response(200, {
      ok: true, kind: "booking", post_id: "synthetic-post", booking_redirect_url: "#must-not-redirect",
    })).mockResolvedValueOnce(response(500, { error: "Synthetic booking seed failed" }));
    await render();
    expect(container.textContent).toContain("Failed to create booking: Synthetic booking seed failed");
    expect(container.querySelector("h1")?.textContent).toBe("Heads up");
    expect(button("Confirming your booking...")).toBeUndefined();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    await advance(120_000);
    expect(window.location.hash).toBe("");
    expect(router.replace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
