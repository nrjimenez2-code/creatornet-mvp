/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "creator" }) }));
import PostComposer from "@/components/PostComposer";
let root: Root, container: HTMLDivElement, mockFetch: jest.Mock;
let generationFails = false, uploadFails = false;
const originalFetch = globalThis.fetch, originalXHR = globalThis.XMLHttpRequest;
const originalCreateURL = URL.createObjectURL, originalRevokeURL = URL.revokeObjectURL;
let createSpy: jest.SpyInstance, canvasSpy: jest.SpyInstance, blobSpy: jest.SpyInstance;
beforeEach(async () => {
  generationFails = false; uploadFails = false;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/stripe/connect/status") return { ok: true, json: async () => ({ onboarding_complete: true, tipping_enabled: true }) };
    if (url === "/api/products") return { ok: true, json: async () => ({ items: [] }) };
    if (url === "/api/upload/presign") return { ok: !uploadFails, json: async () => uploadFails ? { error: "Upload refused" } : { uploadUrl: "https://upload.test", publicUrl: `https://cdn.test/${JSON.parse(String(init?.body)).folder}/asset` } };
    if (url === "/api/posts") return { ok: true, json: async () => ({ success: true }) };
    throw new Error("Unexpected request " + url);
  });
  globalThis.fetch = mockFetch;
  globalThis.XMLHttpRequest = class {
    status = 200; upload = {}; onload?: () => void;
    open() {} setRequestHeader() {} abort() {}
    send() { queueMicrotask(() => this.onload?.()); }
  } as unknown as typeof XMLHttpRequest;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = jest.fn();
  const create = document.createElement.bind(document);
  createSpy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "video") queueMicrotask(() => element.dispatchEvent(new Event(generationFails ? "error" : "seeked")));
    return element;
  });
  canvasSpy = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
  blobSpy = jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["poster"], { type: "image/jpeg" })));
  await act(async () => { root.render(createElement(PostComposer)); });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); createSpy.mockRestore(); canvasSpy.mockRestore(); blobSpy.mockRestore();
  globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXHR;
  URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
});
const button = () => Array.from(container.querySelectorAll("button")).find(node => node.textContent === "Post")!;
const submit = async () => { await act(async () => button().click()); };
const pick = async (label = "Public video") => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["video"], "test.mp4", { type: "video/mp4" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
};
const postRequest = () => mockFetch.mock.calls.find(([url]) => url === "/api/posts");
test("removed controls disappear; full-width video inputs remain keyboard-accessible with booking and selling controls", () => {
  expect(container.textContent).not.toMatch(/Specific topics|Business & Entrepreneurship|Optional thumbnail/);
  expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
  expect(container.querySelector('input[accept="image/jpeg,image/png"]')).toBeNull();
  for (const input of container.querySelectorAll('input[type="file"]')) expect(input.className).not.toContain("hidden");
  expect(container.textContent).toContain('Attach "Buy / Book"'); expect(container.textContent).toContain('Book a free call');
  expect(container.querySelector("textarea")!.maxLength).toBe(300);
});
test("a public video can publish with empty title/caption and an automatically uploaded poster", async () => {
  expect(button().disabled).toBe(true); await pick(); expect(button().disabled).toBe(false); await submit();
  const body = JSON.parse(String(postRequest()![1].body));
  expect(body).toMatchObject({ title: null, content: "", classification_version: 1, poster_url: "https://cdn.test/thumbnails/asset", hashtags: [] });
  expect(body).not.toHaveProperty("interests"); expect(body).not.toHaveProperty("topics");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
test("caption hashtags and character counts remain visible and reach the automatic submission", async () => {
  const caption = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(caption, "#SMMA #smma");
    caption.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("11 / 300"); await pick(); await submit();
  expect(JSON.parse(String(postRequest()![1].body)).hashtags).toEqual(["smma"]);
});
test("poster generation failure preserves the existing null-poster publish behavior", async () => {
  generationFails = true; await pick(); await submit();
  expect(JSON.parse(String(postRequest()![1].body)).poster_url).toBeNull();
});
test("failed uploads leave the picked file available and do not publish a dead URL", async () => {
  uploadFails = true; const error = jest.spyOn(console, "error").mockImplementation(() => {});
  await pick(); await submit();
  expect(postRequest()).toBeUndefined(); expect(container.querySelector('[role="alert"]')!.textContent).toContain("Upload refused");
  expect(container.textContent).toContain("test.mp4"); expect(button().disabled).toBe(false); error.mockRestore();
});
test("premium-only selection does not replace the required public video", async () => {
  await pick("Premium video"); expect(button().disabled).toBe(true); expect(postRequest()).toBeUndefined();
});

test("automatic free-video tips clear premium selection and preserve mutually exclusive payment controls", async () => {
  await pick("Premium video");
  const tipLabel = Array.from(container.querySelectorAll("label")).find(node => node.textContent?.includes("Enable tips on this free video"))!;
  await act(async () => tipLabel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Premium video"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>("#post-price")!.disabled).toBe(true);
  for (const label of Array.from(container.querySelectorAll("label")).filter(node => node.textContent?.includes('Attach "Buy / Book"') || node.textContent?.includes('Book a free call'))) {
    expect(label.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  }
  await pick(); await submit();
  const body = JSON.parse(String(postRequest()![1].body));
  expect(body).toMatchObject({ classification_version: 1, tips_enabled: true, premium_path: null, product_id: null, price_cents: null, allow_booking: false, booking_url: null });
  expect(body).not.toHaveProperty("interests"); expect(body).not.toHaveProperty("topics");
});
