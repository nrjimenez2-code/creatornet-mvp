/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AvatarCropDialog from "@/components/AvatarCropDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onSave = jest.fn(async (photo: Blob) => { expect(photo.type).toBe("image/png"); });
const onCancel = jest.fn();
const drawImage = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLDialogElement.prototype.showModal = jest.fn();
  HTMLDialogElement.prototype.close = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["image"], { type: "image/png" })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

test("previews a tall image and saves the centered square crop only after confirmation", async () => {
  await act(async () => root.render(createElement(AvatarCropDialog, {
    photoUrl: "blob:test", uploading: false, uploadError: null, onCancel, onSave,
  })));

  const image = container.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { value: 924 },
    naturalHeight: { value: 1885 },
  });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(onSave).not.toHaveBeenCalled();
  expect(parseFloat(image.style.height)).toBeCloseTo(522.25, 1);

  const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save photo")!;
  await act(async () => save.click());
  expect(drawImage).toHaveBeenCalledWith(image, 0, 480.5, 924, 924, 0, 0, 512, 512);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }));
});
