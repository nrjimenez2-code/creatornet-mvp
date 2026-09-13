/** @jest-environment jsdom */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BookingConnectionStatus } from "@/lib/schedulingConnectionTypes";
let userId = "creator";
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId, session: { access_token: "token" } }) }));
import SchedulingConnections from "@/components/SchedulingConnections";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
const fetchMock = jest.fn();
let root: Root;
let container: HTMLDivElement;
let connections: BookingConnectionStatus[];
const response = () => ({ ok: true, json: async () => ({ connections }) });
beforeEach(() => {
  userId = "creator";
  connections = [{ provider: "calcom", available: true, status: "disconnected", accountName: null, eventTypes: [] }];
  fetchMock.mockReset().mockImplementation(async () => response());
  global.fetch = fetchMock;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); global.fetch = originalFetch; jest.restoreAllMocks(); });
const click = async (name: string) => { await act(async () => {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === name);
  if (!button) throw new Error(`Missing ${name}`);
  button.click();
}); };

test("authorization window leaves draft text and selected file mounted", async () => {
  const video = new File(["video"], "draft.mp4", { type: "video/mp4" });
  function ComposerHarness() {
    const [caption, setCaption] = useState("My session");
    const [file] = useState(video);
    return createElement("div", null,
      createElement("input", { value: caption, onChange: event => setCaption(event.target.value), "aria-label": "Caption" }),
      createElement("span", null, file.name),
      createElement(SchedulingConnections, { purpose: "session" }));
  }
  const popup = { closed: false } as Window;
  const open = jest.spyOn(window, "open").mockReturnValue(popup);
  await act(async () => root.render(createElement(ComposerHarness)));
  const input = container.querySelector("input");
  await click("Connect Cal.com");
  expect(open).toHaveBeenCalledWith("/scheduling/connect?provider=calcom", "_blank", "popup,width=600,height=760");
  expect(container.querySelector("input")).toBe(input);
  expect(input?.value).toBe("My session");
  expect(container.textContent).toContain("draft.mp4");
  connections = [{ provider: "calcom", available: true, status: "connected", accountName: "Creator", eventTypes: [] }];
  await click("I’m back");
  expect(container.textContent).toContain("Cal.com connected");
  expect(container.querySelector("input")).toBe(input);
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Connect Cal.com")).toBe(false);
});

test("blocked popup retains the prompt and explains how to retry", async () => {
  jest.spyOn(window, "open").mockReturnValue(null);
  await act(async () => root.render(createElement(SchedulingConnections, { purpose: "sales-call" })));
  await click("Connect Cal.com");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your draft is still here");
});

test("saved connection reuses verified event URLs and exposes manage/disconnect", async () => {
  connections[0] = { ...connections[0], status: "connected", accountName: "Creator", eventTypes: [{ id: "12", title: "Consultation", bookingUrl: "https://cal.com/creator/call" }] };
  const select = jest.fn();
  await act(async () => root.render(createElement(SchedulingConnections, { purpose: "sales-call", onSelect: select })));
  await act(async () => {
    const input = container.querySelector("select")!;
    input.value = "https://cal.com/creator/call";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(select).toHaveBeenCalledWith("https://cal.com/creator/call");
  await click("Manage Cal.com");
  await click("Disconnect Cal.com");
  expect(fetchMock).toHaveBeenCalledWith("/api/scheduling/connections", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ provider: "calcom" }) }));
});

test("failed refresh removes stale connected label and permits retry", async () => {
  connections[0].status = "connected";
  await act(async () => root.render(createElement(SchedulingConnections)));
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).not.toContain("Cal.com connected");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  connections[0].status = "reconnect_required";
  await click("Check again");
  expect(container.textContent).toContain("Reconnect Cal.com");
});

test("account switch never displays previous creator's saved account", async () => {
  connections[0] = { ...connections[0], status: "connected", accountName: "Private account" };
  await act(async () => root.render(createElement(SchedulingConnections)));
  userId = "other";
  fetchMock.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => root.render(createElement(SchedulingConnections)));
  expect(container.textContent).not.toContain("Private account");
});
