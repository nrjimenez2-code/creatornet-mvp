/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let mockUser: string | null = "owner";
let mockLoading = false;
const mockSession = jest.fn();
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUser, loading: mockLoading }) }));
jest.mock("@/lib/supabaseClient", () => ({ supabase: { auth: { getSession: mockSession } } }));
import DeleteVideoButton from "@/components/DeleteVideoButton";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const request = jest.fn(), deleted = jest.fn();
const render = () => act(async () => root.render(createElement(DeleteVideoButton, { postId: "post", creatorId: "owner", onDeleted: deleted })));
const click = (label: string) => act(async () => { const button = [...document.querySelectorAll("button")].find(b => (!b.closest("dialog") || b.closest("dialog")!.open) && (b.textContent === label || b.getAttribute("aria-label") === label)); button!.click(); });
beforeEach(() => {
  mockUser = "owner"; mockLoading = false; request.mockReset(); deleted.mockReset();
  mockSession.mockReset().mockResolvedValue({ data: { session: { access_token: "test-token", user: { id: "owner" } } }, error: null });
  global.fetch = request;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test("only the signed-in owner gets the control", async () => {
  for (const user of [null, "other"]) { mockUser = user; await render(); expect(container.querySelector("button")).toBeNull(); }
  mockUser = "owner"; mockLoading = true; await render(); expect(container.querySelector("button")).toBeNull();
  mockLoading = false; await render(); expect(container.querySelector("button")).not.toBeNull();
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
