/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const read = jest.fn(), write = jest.fn(), upload = jest.fn();
const update = jest.fn(() => ({ eq: write }));
const client = {
  from: () => ({ select: () => ({ eq: () => ({ returns: () => ({ maybeSingle: read }) }) }), update }),
  storage: { from: () => ({ uploadToSignedUrl: upload }) },
};
jest.mock("@/lib/supabaseBrowser", () => ({ createBrowserClient: () => client }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: null }), useRequireUser: () => ({ userId: "viewer", loading: false }) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }) }));
import Page from "@/app/profile/edit/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalCreateURL = URL.createObjectURL, originalRevokeURL = URL.revokeObjectURL;
let root: Root, container: HTMLDivElement, request: jest.Mock;
let paused = false, verificationFails = false;
let renderBlob: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks(); paused = false; verificationFails = false;
  read.mockResolvedValue({ data: { username: "viewer", avatar_url: "https://cdn.test/old.png" }, error: null });
  write.mockResolvedValue({ error: null }); upload.mockResolvedValue({ error: null });
  HTMLDialogElement.prototype.showModal = jest.fn(); HTMLDialogElement.prototype.close = jest.fn();
  URL.createObjectURL = jest.fn(() => "blob:crop-retry"); URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D);
  renderBlob = jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["cropped"], { type: "image/png" })));
  const admitted = new Map<string, string>();
  request = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/upload/admit") {
      const input = JSON.parse(String(init?.body)); const key = `viewer/${input.attemptId}.png`;
      admitted.set(input.attemptId, key);
      return { ok: !paused, status: paused ? 503 : 200, json: async () => paused ? { error: "Admission paused" } : {
        attemptId: input.attemptId, key, publicUrl: "https://cdn.test/new.png",
        capability: { provider: "supabase", key, bucket: "avatars", token: "mock-token" },
      } };
    }
    return { ok: !verificationFails, status: verificationFails ? 409 : 200, json: async () => verificationFails
      ? { error: "Verification pending" } : { objectObserved: true, key: admitted.get(url.split("/")[3]) } };
  });
  globalThis.fetch = request;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(createElement(Page)));
});

afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks();
  globalThis.fetch = originalFetch; URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
});

async function chooseAndLoad() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "photo.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  const image = container.querySelector<HTMLImageElement>("dialog img")!;
  Object.defineProperties(image, { naturalWidth: { value: 900 }, naturalHeight: { value: 1600 } });
  await act(async () => image.dispatchEvent(new Event("load")));
}
const save = async () => { await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Save photo")!.click()); };

test.each(["verification", "profile write"])("real crop/profile flow retries after %s failure while admission is paused", async failure => {
  await chooseAndLoad(); verificationFails = failure === "verification";
  if (failure === "profile write") write.mockResolvedValueOnce({ error: { message: "Profile write pending" } });
  await save();
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.querySelector("dialog")).not.toBeNull();
  expect(upload).toHaveBeenCalledTimes(1); expect(renderBlob).toHaveBeenCalledTimes(1);
  const attemptId = JSON.parse(String(request.mock.calls.find(([url]) => url === "/api/upload/admit")![1].body)).attemptId;
  paused = true; verificationFails = false;
  await save();
  expect(request.mock.calls.filter(([url]) => url === "/api/upload/admit")).toHaveLength(1);
  expect(request.mock.calls.filter(([url]) => url === `/api/upload/${attemptId}/complete`)).toHaveLength(2);
  expect(upload).toHaveBeenCalledTimes(1); expect(renderBlob).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenLastCalledWith({ avatar_url: "https://cdn.test/new.png" });
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.querySelector('[role="status"]')!.textContent).toContain("photo is live");
});
