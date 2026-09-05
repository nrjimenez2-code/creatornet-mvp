/**
 * @jest-environment jsdom
 */
/**
 * components/ReviewForm shows every refusal INLINE (setError), never via
 * alert(). The purchaser-only gate (lib/reviewEligibility.ts) answers a
 * signed-in non-buyer with 403 PURCHASE_REQUIRED, and that message has to
 * land in an announced (role="alert") region under the form, with the
 * buyer's draft rating + comment left intact so they can read it.
 *
 * Renders the REAL component with react-dom against a stubbed fetch.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PURCHASE_REQUIRED_CODE, PURCHASE_REQUIRED_MESSAGE } from "@/lib/reviewEligibility";

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({}) }));
jest.mock("@/lib/supabaseServer", () => ({ createSupabaseServer: async () => ({}) }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "buyer_1", session: null, loading: false }),
}));

// Imported after the mocks above are registered (jest hoists the factories).
import ReviewForm from "@/components/ReviewForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMENT = "Great coaching, worth every cent.";

let container: HTMLDivElement;
let root: Root;
let fetchMock: jest.Mock;
let alertMock: jest.Mock;
let errorSpy: jest.SpyInstance;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Type into a React-controlled textarea: native setter + bubbling input event. */
function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillAndSubmit() {
  const star5 = container.querySelector<HTMLButtonElement>('button[aria-label="Rate 5 stars"]')!;
  const textarea = container.querySelector<HTMLTextAreaElement>("#review-comment")!;
  const form = container.querySelector<HTMLFormElement>("form")!;
  expect(star5 && textarea && form).toBeTruthy();

  await act(async () => {
    star5.click();
    typeInto(textarea, COMMENT);
  });
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(async () => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  alertMock = jest.fn();
  (globalThis as { alert?: unknown }).alert = alertMock;
  // The component logs the refusal; expected here, keep output clean.
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(ReviewForm, { creatorId: "creator_1" }));
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  errorSpy.mockRestore();
});

describe("ReviewForm shows the purchaser-only refusal inline", () => {
  it("renders the 403 PURCHASE_REQUIRED message in a role=alert region and keeps the draft", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { code: PURCHASE_REQUIRED_CODE, error: PURCHASE_REQUIRED_MESSAGE })
    );

    await fillAndSubmit();

    // It posted to the real route with the creator id from props.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reviews");
    expect(JSON.parse(init.body)).toEqual({ creator_id: "creator_1", rating: 5, comment: COMMENT });

    // Refusal shown inline, announced, never via alert().
    const alertRegion = container.querySelector('[role="alert"]');
    expect(alertRegion?.textContent).toBe(PURCHASE_REQUIRED_MESSAGE);
    expect(alertMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).toBeNull();

    // The draft survives so the buyer can read the message and keep the text.
    expect(container.querySelector<HTMLTextAreaElement>("#review-comment")!.value).toBe(COMMENT);
    expect(container.textContent).toContain("5 stars");
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Submit Review");
  });

  it("falls back to a generic message when the refusal body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    });

    await fillAndSubmit();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Failed to submit review");
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("shows success in a role=status region and clears the draft on 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, review: {}, rating: null }));

    await fillAndSubmit();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Review submitted successfully");
    expect(container.querySelector<HTMLTextAreaElement>("#review-comment")!.value).toBe("");
  });
});
