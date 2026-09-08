/**
 * @jest-environment jsdom
 */
/**
 * components/UserRow.tsx — a follow whose account has no profiles row.
 *
 * 34 of 47 production accounts never finished onboarding, so they have no
 * public.profiles row. Those follows still belong in the followers list (the
 * follower count includes them), but the row used to render as "@creator"
 * linking to /creators/<uuid>, which 404s. Confirmed on the live "Abhinav"
 * profile: two of four followers were in exactly that state.
 *
 * Mutation check: delete the `user.has_profile === false` branch in UserRow and
 * the first test fails.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

import UserRow from "@/components/UserRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

async function render(user: Parameters<typeof UserRow>[0]["user"]) {
  await act(async () => {
    root.render(createElement(UserRow, { user }));
  });
}

test("a follower with no profile row is not a link", async () => {
  await render({
    id: "8a962ac4-e44e-4d5c-8aca-4e947686387d",
    username: null,
    full_name: null,
    avatar_url: null,
    has_profile: false,
  });

  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("Account not set up");
  // and it must not advertise a profile that does not exist
  expect(container.textContent).not.toContain("@creator");
});

test("a real follower still renders as a link to their profile", async () => {
  await render({
    id: "073e7bcb-5986-49cc-8be9-8567c6494562",
    username: "luis",
    full_name: null,
    avatar_url: null,
    has_profile: true,
  });

  const link = container.querySelector("a");
  expect(link).not.toBeNull();
  expect(link?.getAttribute("href")).toBe("/creators/luis");
  expect(container.textContent).toContain("@luis");
});

test("has_profile omitted keeps the old link behaviour (older callers)", async () => {
  await render({ id: "abc", username: "someone", full_name: null, avatar_url: null });

  expect(container.querySelector("a")?.getAttribute("href")).toBe("/creators/someone");
});
