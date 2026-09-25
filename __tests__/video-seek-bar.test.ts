/** @jest-environment jsdom */
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import VideoSeekBar from "@/components/VideoSeekBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const videoRef = createRef<HTMLVideoElement>();
  await act(async () => root.render(createElement("div", null,
    createElement("video", { ref: videoRef }),
    createElement(VideoSeekBar, { videoRef }),
  )));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("the timeline follows playback and seeks in either direction", async () => {
  const video = container.querySelector("video")!;
  const slider = container.querySelector<HTMLInputElement>('input[aria-label="Seek video"]')!;
  expect(slider.disabled).toBe(true);

  Object.defineProperty(video, "duration", { configurable: true, value: 90 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  expect(slider.disabled).toBe(false);
  expect(slider.max).toBe("90");

  video.currentTime = 12;
  await act(async () => video.dispatchEvent(new Event("timeupdate")));
  expect(slider.value).toBe("12");

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    nativeValueSetter.call(slider, "70");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(video.currentTime).toBe(70);
  expect(slider.getAttribute("aria-valuetext")).toBe("1:10 of 1:30");

  await act(async () => {
    nativeValueSetter.call(slider, "5");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(video.currentTime).toBe(5);
});

test("unavailable or changing duration never leaves an active stale seek control", async () => {
  const video = container.querySelector("video")!;
  const slider = container.querySelector<HTMLInputElement>('input[aria-label="Seek video"]')!;
  Object.defineProperty(video, "duration", { configurable: true, value: 60 });
  await act(async () => video.dispatchEvent(new Event("durationchange")));
  expect(slider.disabled).toBe(false);

  Object.defineProperty(video, "duration", { configurable: true, value: Infinity });
  await act(async () => video.dispatchEvent(new Event("durationchange")));
  expect(slider.disabled).toBe(true);
});

test("the time readout appears only while seeking with a pointer or keyboard", async () => {
  const video = container.querySelector("video")!;
  const slider = container.querySelector<HTMLInputElement>('input[aria-label="Seek video"]')!;
  Object.defineProperty(video, "duration", { configurable: true, value: 90 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));

  expect(container.textContent).not.toContain("0:00 / 1:30");
  await act(async () => slider.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(container.textContent).toContain("0:00 / 1:30");
  await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
  expect(container.textContent).not.toContain("0:00 / 1:30");

  await act(async () => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(container.textContent).toContain("0:00 / 1:30");
  await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })));
  expect(container.textContent).not.toContain("0:00 / 1:30");
});

test("touch preview follows the finger and resumes playback tracking after an outside release", async () => {
  const video = container.querySelector("video")!;
  const slider = container.querySelector<HTMLInputElement>('input[aria-label="Seek video"]')!;
  const touchTarget = container.querySelector<HTMLElement>(".video-seek-touch-target")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 90 });
  Object.defineProperty(touchTarget, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, width: 300 }),
  });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));

  const pointer = (type: string, clientX: number) => Object.assign(new Event(type, { bubbles: true }), {
    pointerId: 7,
    clientX,
  });
  await act(async () => touchTarget.dispatchEvent(pointer("pointerdown", 30)));
  expect(slider.value).toBe("9");
  expect(container.textContent).toContain("0:09 / 1:30");

  await act(async () => touchTarget.dispatchEvent(pointer("pointermove", 240)));
  expect(slider.value).toBe("72");
  await act(async () => window.dispatchEvent(pointer("pointermove", 270)));
  expect(slider.value).toBe("81");
  await act(async () => window.dispatchEvent(pointer("pointerup", 270)));
  expect(video.currentTime).toBe(81);
  expect(container.textContent).not.toContain("1:21 / 1:30");

  video.currentTime = 82;
  await act(async () => video.dispatchEvent(new Event("timeupdate")));
  expect(slider.value).toBe("82");

  await act(async () => touchTarget.dispatchEvent(pointer("pointerdown", 60)));
  await act(async () => window.dispatchEvent(new Event("blur")));
  video.currentTime = 83;
  await act(async () => video.dispatchEvent(new Event("timeupdate")));
  expect(slider.value).toBe("83");
});
