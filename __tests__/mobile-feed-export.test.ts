/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import MobileFeedDiagnostics from "@/components/MobileFeedDiagnostics";
import { exportFeedTrace, recordFeedEvent, resetFeedTrace } from "@/lib/mobileFeedDiagnostics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let files: Blob[];
const canShare = jest.fn();
const share = jest.fn();
const revoke = jest.fn();
const descriptors = {
  canShare: Object.getOwnPropertyDescriptor(navigator, "canShare"),
  share: Object.getOwnPropertyDescriptor(navigator, "share"),
  createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(node => node.textContent === text)!;
  await act(async () => button.click());
};
const fill = async (field: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${field}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  files = [];
  canShare.mockReset().mockReturnValue(false);
  share.mockReset().mockResolvedValue(undefined);
  revoke.mockReset();
  Object.defineProperties(navigator, { canShare: { configurable: true, value: canShare }, share: { configurable: true, value: share } });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: jest.fn((file: Blob) => { files.push(file); return `blob:trace-${files.length}`; }) },
    revokeObjectURL: { configurable: true, value: revoke },
  });
  window.history.replaceState({}, "", "/?feedDebug=1");
  resetFeedTrace();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(MobileFeedDiagnostics, { activePostId: null, getVideo: () => null })));
  await click("Capture controls");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const target = name === "canShare" || name === "share" ? navigator : URL;
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  }
});

test("a rejected native share keeps a real JSON download and the captured events", async () => {
  canShare.mockReturnValue(true);
  share.mockRejectedValue(new DOMException("Sharing blocked", "NotAllowedError"));
  recordFeedEvent("preparation-miss", { postId: "post-a" });
  const before = exportFeedTrace().events;
  await click("Export trace");
  const link = container.querySelector<HTMLAnchorElement>("a[download]")!;
  expect(link.href).toBe("blob:trace-1");
  expect(link.download).toMatch(/^creatornet-feed-\d+\.json$/);
  expect(files[0].type).toBe("application/json");
  const json = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(files[0]);
  });
  expect(JSON.parse(json)).toEqual(expect.objectContaining({ schema: 1, events: before }));
  expect(container.textContent).toContain("Sharing unavailable. Your trace is retained");
  expect(exportFeedTrace().events).toEqual(before);
});

test("cancelling sharing preserves the entered run context when controls are hidden", async () => {
  canShare.mockReturnValue(true);
  share.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  await fill("runId", "safari-run-01");
  await fill("buildCommit", "verified-commit");
  await click("Hide capture controls");
  await click("Capture controls");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="runId"]')!.value).toBe("safari-run-01");
  await click("Export trace");
  expect(container.textContent).toContain("Sharing cancelled");
  expect(container.querySelector("a[download]")).not.toBeNull();
  expect(exportFeedTrace().context).toEqual(expect.objectContaining({ runId: "safari-run-01", buildCommit: "verified-commit" }));
});

test("unsupported native sharing offers an explicit download without claiming a saved file", async () => {
  await click("Export trace");
  expect(share).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Trace ready. Tap Download JSON to save it.");
  expect(container.textContent).not.toContain("Trace exported");
  const link = container.querySelector<HTMLAnchorElement>("a[download]")!;
  link.addEventListener("click", event => event.preventDefault(), { once: true });
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain("Download requested. Confirm the JSON file was saved");
});

test("replacing an export and starting a new run release the prior download URLs", async () => {
  await click("Export trace");
  await click("Export trace");
  expect(revoke).toHaveBeenCalledWith("blob:trace-1");
  expect(container.querySelector<HTMLAnchorElement>("a[download]")!.href).toBe("blob:trace-2");
  await click("Start new run");
  expect(revoke).toHaveBeenCalledWith("blob:trace-2");
  expect(container.querySelector("a[download]")).toBeNull();
  await click("Export trace");
  await act(async () => root.unmount());
  expect(revoke).toHaveBeenCalledWith("blob:trace-3");
});
