/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFeedPlaybackResolution } from "@/lib/useFeedPlaybackResolution";
import { mobilePlaybackDelivery, parseResolvedPlayback, publicVideoKey, requestFeedPlayback, selectResolvedPlayback } from "@/lib/feedPlaybackResolution";
import { planMobileFallback } from "@/lib/mobileFeedRecovery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = "videos/fixture.mp4", version = "sha256:" + "a".repeat(64);
const original = "https://media.creatornet.net/" + key;
const descriptor = { key, contentVersion: version, originalUrl: original, processedMp4Url: "https://media.creatornet.net/feed-auto/"+"a".repeat(64)+".mp4", hlsUrl: "https://customer-test.cloudflarestream.com/"+"b".repeat(32)+"/manifest/video.m3u8", durationSeconds: 30 };
const fetchMock = jest.fn();
let root: Root, container: HTMLDivElement;
let latest: ReturnType<typeof useFeedPlaybackResolution>;
const defaults = { postId: "fixture", original, fallback: "https://media.creatornet.net/auto/"+key, mobile: true, controller: true, active: true, neighbor: false, visible: true, nativeHls: true };
function Harness(props: Partial<typeof defaults>) { latest = useFeedPlaybackResolution({...defaults,...props}); return null; }
const render = async (props = {}) => { await act(async () => root.render(createElement(Harness, props))); };
beforeEach(() => {
  jest.useFakeTimers(); fetchMock.mockReset(); globalThis.fetch = fetchMock;
  window.history.replaceState({}, "", "/?feedBridge=1");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });
test("only explicit public video paths are resolvable and descriptors bind MP4 to content version", () => {
  expect(publicVideoKey(original)).toBe(key);
  for (const source of ["https://evil.test/videos/a.mp4", original+"?signed=private", "https://media.creatornet.net/private/a.mp4"]) expect(publicVideoKey(source)).toBeNull();
  expect(parseResolvedPlayback(descriptor,key)).toEqual(descriptor);
  expect(parseResolvedPlayback({...descriptor,contentVersion:"sha256:"+"c".repeat(64)},key)).toBeNull();
  expect(parseResolvedPlayback({...descriptor,hlsUrl:"https://evil.test/a.m3u8"},key)).toBeNull();
});
test("deduplicated credential-free requests abort only when all subscribers cancel", async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const a = requestFeedPlayback(original), b = requestFeedPlayback(original);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const options = fetchMock.mock.calls[0][1]; expect(options.credentials).toBe("omit"); expect(options.cache).toBe("no-store");
  a.cancel(); expect(options.signal.aborted).toBe(false); b.cancel(); expect(options.signal.aborted).toBe(true);
});
test("one-second timeout pins ordinary playback and discards a late descriptor", async () => {
  let resolve!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(res => {resolve=res}));
  await render(); expect(latest.waiting).toBe(true);
  await act(async () => jest.advanceTimersByTime(999)); expect(latest.waiting).toBe(true);
  await act(async () => jest.advanceTimersByTime(1)); expect(latest.waiting).toBe(false); expect(latest.source).toBe(defaults.fallback);
  await act(async () => resolve({ok:true,json:async()=>descriptor}));
  expect(latest.source).toBe(defaults.fallback); expect(latest.descriptor).toBeNull();
});
test("resolved neighbor transfers a pinned source; only active and selected neighbor resolve", async () => {
  fetchMock.mockResolvedValue({ok:true,json:async()=>descriptor});
  await render({active:false,neighbor:false}); expect(fetchMock).not.toHaveBeenCalled();
  await render({active:false,neighbor:true}); expect(latest.source).toBe(descriptor.processedMp4Url);
  await render({active:true,neighbor:false}); expect(fetchMock).toHaveBeenCalledTimes(1);
  await render({active:true,visible:false}); expect(latest.source).toBe(descriptor.processedMp4Url);
});
test("obsolete responses cannot populate a different neighbor or a desktop card", async () => {
  let resolve!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(res => {resolve=res}));
  await render({active:false,neighbor:true}); await render({original:"https://media.creatornet.net/videos/new.mp4",active:false,neighbor:false});
  await act(async () => resolve({ok:true,json:async()=>descriptor})); expect(latest.descriptor).toBeNull();
  fetchMock.mockClear(); await render({mobile:false}); expect(fetchMock).not.toHaveBeenCalled();
});
test("delivery and controller have independent rollback switches; HLS requires an explicit trial", () => {
  expect(selectResolvedPlayback(descriptor,"mp4",true)).toBe(descriptor.processedMp4Url);
  expect(selectResolvedPlayback(descriptor,"hls-trial",false)).toBe(descriptor.processedMp4Url);
  window.history.replaceState({},"","/?feedBridge=1&feedDelivery=0"); expect(mobilePlaybackDelivery(true)).toBe("off");
  window.history.replaceState({},"","/?feedBridge=0&feedDelivery=mp4"); expect(mobilePlaybackDelivery(false)).toBe("mp4");
});
test("nonzero fallback proofs must match exact content version and attempts cannot loop", () => {
  const proof=[{contentVersion:version,from:"hls",to:"mp4",offsetSeconds:0,evidence:"verified-fixture"}];
  expect(planMobileFallback("hls","mp4",12,new Set(),proof,"new-version").kind).toBe("terminal");
  const tried = new Set<string>(); expect(planMobileFallback("hls","mp4",12,tried,proof,version).kind).toBe("replace");
  expect(planMobileFallback("mp4","mp4",12,tried,proof,version).kind).toBe("terminal");
});
