/**
 * @jest-environment jsdom
 */
/**
 * components/ReviewForm names the offer being reviewed. The page passes the
 * viewer's live-purchased offers (lib/reviewEligibility.ts
 * viewerPurchasedPosts); the form renders them in a <select> labelled by
 * post title, preselects the first, and sends the chosen post_id with the
 * review. Renders the REAL component with react-dom against a stubbed fetch.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PURCHASE_REQUIRED_MESSAGE, type PurchasedPost } from "@/lib/reviewMessages";

jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({}) }));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "buyer_1", session: null, loading: false }),
}));

import ReviewForm from "@/components/ReviewForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMENT = "The course was worth every cent.";
const OFFERS: PurchasedPost[] = [
  { post_id: "post_clip", title: "Quick clip" },
  { post_id: "post_course", title: "Full course" },
];

let container: HTMLDivElement;
let root: Root;
let fetchMock: jest.Mock;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Change a React-controlled select: native setter + bubbling change event. */
function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function render(offers: PurchasedPost[]) {
  await act(async () => {
    root.render(createElement(ReviewForm, { creatorId: "creator_1", offers }));
  });
}

async function fillAndSubmit() {
  const star5 = container.querySelector<HTMLButtonElement>('button[aria-label="Rate 5 stars"]')!;
  const textarea = container.querySelector<HTMLTextAreaElement>("#review-comment")!;
  const form = container.querySelector<HTMLFormElement>("form")!;
  await act(async () => {
    star5.click();
    typeInto(textarea, COMMENT);
  });
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ success: true, review: {}, rating: null }),
  });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("ReviewForm names the offer", () => {
  it("renders the purchased offers as a labelled select, first one preselected", async () => {
    await render(OFFERS);

    const label = container.querySelector<HTMLLabelElement>('label[for="review-offer"]');
    expect(label?.textContent).toContain("Offer");

    const select = container.querySelector<HTMLSelectElement>("#review-offer")!;
    const options = Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent }));
    expect(options).toEqual([
      { value: "post_clip", text: "Quick clip" },
      { value: "post_course", text: "Full course" },
    ]);
    expect(select.value).toBe("post_clip");
  });

  it("sends the preselected post_id with the review", async () => {
    await render(OFFERS);
    await fillAndSubmit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/reviews");
    expect(sentBody()).toEqual({
      creator_id: "creator_1",
      post_id: "post_clip",
      rating: 5,
      comment: COMMENT,
    });
  });

  it("sends the offer the buyer switched to", async () => {
    await render(OFFERS);
    await act(async () => {
      choose(container.querySelector<HTMLSelectElement>("#review-offer")!, "post_course");
    });
    await fillAndSubmit();

    expect(sentBody()).toMatchObject({ post_id: "post_course" });
  });

  it("a single offer is preselected too, so nothing extra to click", async () => {
    await render([OFFERS[1]]);
    const select = container.querySelector<HTMLSelectElement>("#review-offer")!;
    expect(select.options).toHaveLength(1);
    expect(select.value).toBe("post_course");

    await fillAndSubmit();
    expect(sentBody()).toMatchObject({ post_id: "post_course" });
  });

  it("with nothing to review it shows the purchase note instead of an empty select", async () => {
    await render([]);

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("#review-offer")).toBeNull();
    expect(container.textContent).toBe(PURCHASE_REQUIRED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
