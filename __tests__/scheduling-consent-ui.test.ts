/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let provider = "google";
let userId: string | null = "creator";
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ provider }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId, loading: false, session: { access_token: "test-token" } }) }));
import ConnectPage from "@/app/scheduling/connect/page";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
const fetchMock = jest.fn();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  provider = "google"; userId = "creator";
  fetchMock.mockReset().mockResolvedValue({ ok: false, json: async () => ({ error: "Try again" }) });
  global.fetch = fetchMock;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); global.fetch = originalFetch; });
const render = async () => { await act(async () => root.render(createElement(ConnectPage))); };
const continueButton = () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.startsWith("Continue to"))!;

test.each(["google", "calcom", "calendly"])("%s authorization waits for an explicit action after data-use disclosure", async value => {
  provider = value;
  await render();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toContain("feed recommendations");
  expect(container.textContent).toContain("encrypted authorization tokens");
  expect(container.querySelector('a[href="/legal/privacy#connected-calendars"]')).not.toBeNull();
  await act(async () => continueButton().click());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/scheduling/oauth/start", expect.objectContaining({ method: "POST", body: JSON.stringify({ provider: value }) }));
});

test("failed authorization can be retried without bypassing the disclosure", async () => {
  await render();
  await act(async () => continueButton().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try again");
  expect(continueButton().disabled).toBe(false);
  await act(async () => continueButton().click());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("signed-out and unsupported connections cannot start authorization", async () => {
  userId = null;
  await render();
  await act(async () => continueButton().click());
  expect(container.textContent).toContain("Sign in to CreatorNet");
  expect(fetchMock).not.toHaveBeenCalled();
  provider = "unknown";
  await render();
  expect(continueButton()).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
