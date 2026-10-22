/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReleaseControls from "@/components/admin/ReleaseControls";
import { closedFeatures, SETTINGS_ID, type ReleaseSettings } from "@/lib/release/policy";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, settings: ReleaseSettings, fetchMock: jest.Mock;
beforeEach(() => {
  settings = { id: SETTINGS_ID, owner_id: "owner", hidden: false, features: closedFeatures(), public_page: "coming-soon", discord_invite: "https://discord.gg/bKC8q4z6B", revision: 7, updated_at: "now" };
  fetchMock = jest.fn(); global.fetch = fetchMock;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const render = (testers: Array<{user_id:string;approved_at:string}> = []) => act(async () => root.render(createElement(ReleaseControls, { initial: { settings, testers, audit: [] } })));
const button = (text: string) => [...container.querySelectorAll("button")].find(element => element.textContent === text)!;
const toggle = (label: string) => [...container.querySelectorAll("label")].find(element => element.textContent?.startsWith(label))!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
test("master hide sends the saved feature map and refreshes the resulting server state", async () => {
  settings.features.feed = true;
  fetchMock.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ settings: { ...settings, hidden: true, revision: 8 }, testers: [], audit: [] }));
  await render(); await act(async () => button("Hide website now").click());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ revision: 7, hidden: true, features: settings.features, discordInvite: settings.discord_invite });
  expect(button("Hide website now").disabled).toBe(true); expect(container.textContent).toContain("Public website: Hidden");
});
test("missing dependencies block save; opening one capability leaves unrelated choices closed", async () => {
  await render(); await act(async () => toggle("New purchases").click());
  expect(button("Save release settings").disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => toggle("Creator profiles").click()); await act(async () => toggle("Products and offers").click());
  expect(button("Save release settings").disabled).toBe(false); expect(toggle("Search and hashtags").checked).toBe(false); expect(toggle("New memberships").checked).toBe(false);
});
test("an uncertain or stale mutation produces a visible error and is never automatically replayed", async () => {
  fetchMock.mockResolvedValueOnce(response({ error: "Settings changed. Reload before saving." }, false));
  await render(); await act(async () => button("Hide website now").click());
  expect(container.textContent).toContain("Settings changed. Reload before saving."); expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("tester revocation sends only its exact existing account ID, decision and revision", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  fetchMock.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ settings: { ...settings, revision: 8 }, testers: [], audit: [] }));
  await render([{ user_id: id, approved_at: "now" }]); await act(async () => button("Revoke access").click());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/releases/testers"); expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ userId: id, approved: false, revision: 7 });
  expect(container.textContent).toContain("No testers are approved.");
});

test.each(["blank", "coming-soon"] as const)("owner can save %s independently of feature settings", async publicPage => {
  settings.hidden = true; settings.public_page = publicPage === "blank" ? "coming-soon" : "blank";
  fetchMock.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ settings: { ...settings, public_page: publicPage, revision: 8 }, testers: [], audit: [] }));
  await render();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLInputElement>(`input[type=radio][value="${publicPage}"]`)!.click());
  await act(async () => button("Save public page").click());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/releases/public-page");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ publicPage, revision: 7 });
  expect(container.textContent).toContain(`Saved public page: ${publicPage === "blank" ? "Blank page" : "Coming Soon"}`);
  expect(toggle("Hide website").checked).toBe(true);
});
