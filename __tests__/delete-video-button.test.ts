/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
let mockUser: string | null = "owner";
let mockLoading = false;
const mockSession = jest.fn();
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUser, loading: mockLoading }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ auth: { getSession: mockSession } }) }));
import DeleteVideoButton from "@/components/DeleteVideoButton";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const request = jest.fn(), deleted = jest.fn();
const notInterested = jest.fn();
const render = (onNotInterested?: () => void) => act(async () => root.render(createElement(DeleteVideoButton, { postId: "post", creatorId: "owner", onDeleted: deleted, onNotInterested })));
const click = (label: string) => act(async () => { const button = [...document.querySelectorAll("button")].find(b => (!b.closest("dialog") || b.closest("dialog")!.open) && (b.textContent === label || b.getAttribute("aria-label") === label)); button!.click(); });
beforeEach(() => {
  mockUser = "owner"; mockLoading = false; request.mockReset(); deleted.mockReset(); notInterested.mockReset();
  mockSession.mockReset().mockResolvedValue({ data: { session: { access_token: "test-token", user: { id: "owner" } } }, error: null });
  global.fetch = request;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test("server rendering does not create dialog portals", () => {
  mockUser = "other";
  expect(() => renderToStaticMarkup(createElement(DeleteVideoButton, { postId: "post", creatorId: "owner", onDeleted: deleted }))).not.toThrow();
});
test("the control offers reporting to viewers, including a sign-in prompt for guests", async () => {
  for (const user of [null, "other"]) { mockUser = user; await render(); expect(container.querySelector("button")).not.toBeNull(); }
  mockUser = "owner"; mockLoading = true; await render(); expect(container.querySelector("button")).toBeNull();
  mockLoading = false; await render(); expect(container.querySelector("button")).not.toBeNull();
  mockUser = null; await render(); await click("Video options"); await click("Report video");
  expect(document.body.textContent).toContain("Sign in to report");
});
test("a non-owner gets not interested and report without owner deletion", async () => {
  mockUser = "other";
  await render(notInterested);
  await click("Video options");
  expect(document.body.textContent).toContain("Not interested");
  expect(document.body.textContent).toContain("Report video");
  expect(document.body.textContent).not.toContain("Delete video");
  await click("Not interested");
  expect(notInterested).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
test("the owner keeps the delete menu when not interested is also available", async () => {
  await render(notInterested);
  await click("Video options");
  expect(document.body.textContent).toContain("Delete video");
  expect(document.body.textContent).not.toContain("Not interested");
  expect(document.body.textContent).not.toContain("Report video");
});
test("a non-owner can report with a reason and optional details", async () => {
  mockUser = "other";
  mockSession.mockResolvedValue({ data: { session: { access_token: "other-token", user: { id: "other" } } }, error: null });
  request.mockResolvedValue({ ok: true, json: async () => ({ ok: true, reportId: "report-1" }) });
  await render(); await click("Video options"); await click("Report video");
  const choice = document.querySelector<HTMLInputElement>('input[value="sexual_content"]')!;
  await act(async () => choice.click());
  const details = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(details, "Explicit imagery"); details.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Submit report");
  expect(request).toHaveBeenCalledWith("/api/post-reports", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ Authorization: "Bearer other-token" }),
  }));
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ postId: "post", reason: "sexual_content", details: "Explicit imagery" });
  expect(document.body.textContent).toContain("Report received");
  expect(deleted).not.toHaveBeenCalled();
});
test("a failed report remains open for retry", async () => {
  mockUser = "other";
  mockSession.mockResolvedValue({ data: { session: { access_token: "other-token", user: { id: "other" } } }, error: null });
  request.mockResolvedValue({ ok: false, json: async () => ({ error: "Could not save this report." }) });
  await render(); await click("Video options"); await click("Report video");
  await act(async () => document.querySelector<HTMLInputElement>('input[value="spam"]')!.click());
  await click("Submit report");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not save this report.");
  expect(document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="report-title-post"]')?.open).toBe(true);
});
test("confirmation explains buyer access and cancel sends nothing", async () => {
  await render(); await click("Video options"); await click("Delete video");
  expect(document.querySelector<HTMLDialogElement>("dialog[aria-labelledby]")?.open).toBe(true);
  expect(document.body.textContent).toContain("Buyers keep access");
  await click("Cancel"); expect(request).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled();
});
test("success uses current bearer auth and removes the card only after success", async () => {
  request.mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });
  await render(); await click("Video options"); await click("Delete video"); await click("Delete");
  expect(request).toHaveBeenCalledWith("/api/posts/post", expect.objectContaining({ method: "DELETE", headers: { Authorization: "Bearer test-token" } }));
  expect(deleted).toHaveBeenCalledTimes(1);
});
test("server error keeps the video and allows retry", async () => {
  request.mockResolvedValue({ ok: false, json: async () => ({ error: "Please try again." }) });
  await render(); await click("Video options"); await click("Delete video"); await click("Delete");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Please try again.");
  expect(deleted).not.toHaveBeenCalled(); expect(document.querySelector<HTMLDialogElement>("dialog[aria-labelledby]")?.open).toBe(true);
});
test("a changed or expired session cannot submit", async () => {
  mockSession.mockResolvedValue({ data: { session: null }, error: null });
  await render(); await click("Video options"); await click("Delete video"); await click("Delete");
  expect(request).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled();
});
