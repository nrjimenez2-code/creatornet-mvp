/** @jest-environment jsdom */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFeedPlaybackResolution } from "@/lib/useFeedPlaybackResolution";
import { mobilePlaybackDelivery, parseResolvedPlayback, publicVideoKey, requestFeedPlayback, selectResolvedPlayback } from "@/lib/feedPlaybackResolution";
import { planMobileFallback } from "@/lib/mobileFeedRecovery";
import * as diagnostics from "@/lib/mobileFeedDiagnostics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = "videos/fixture.mp4", version = "sha256:" + "a".repeat(64);
const original = "https://media.creatornet.net/" + key;
const descriptor = { key, contentVersion: version, originalUrl: original, processedMp4Url: "https://media.creatornet.net/feed-auto/"+"a".repeat(64)+".mp4", hlsUrl: "https://customer-test.cloudflarestream.com/"+"b".repeat(32)+"/manifest/video.m3u8", durationSeconds: 30 };
const fetchMock = jest.fn();
let root: Root, container: HTMLDivElement;
let latest: ReturnType<typeof useFeedPlaybackResolution>;
const defaults = { postId: "fixture", original, fallback: "https://media.creatornet.net/auto/"+key, mobile: true, controller: true, active: true, neighbor: false, visible: true, nativeHls: true };
function Harness(props: Partial<typeof defaults>) {
  const resolution = useFeedPlaybackResolution({...defaults,...props});
  useEffect(() => { latest = resolution; });
  return null;
}
const render = async (props = {}) => { await act(async () => root.render(createElement(Harness, props))); };
beforeEach(() => {
  jest.useFakeTimers(); fetchMock.mockReset(); globalThis.fetch = fetchMock;
  window.history.replaceState({}, "", "/?feedBridge=1");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); jest.useRealTimers(); });
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
test.each(["timeout", "http-error"])("%s neighbor fallback stays pinned through activation and visibility changes", async reason => {
  fetchMock.mockImplementation(() => reason === "timeout" ? new Promise(() => {}) : Promise.resolve({ ok: false, status: 503 }));
  await render({ active: false, neighbor: true });
  if (reason === "timeout") await act(async () => jest.advanceTimersByTime(1_000));
  expect(latest.waiting).toBe(false); expect(latest.source).toBe(defaults.fallback);
  // A successful later lookup must not be started while this selection plays.
  fetchMock.mockResolvedValue({ ok: true, json: async () => descriptor });
  await render({ active: true, neighbor: false });
  await render({ active: true, visible: false });
  await render({ active: true, visible: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(latest.source).toBe(defaults.fallback); expect(latest.descriptor).toBeNull();
});
test("a new inactive preparation refreshes the version before another activation", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => descriptor });
  await render();
  let resolve!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
  await render({ active: false, neighbor: true });
  expect(latest.waiting).toBe(true); expect(latest.descriptor).toBeNull();
  const replacement = { ...descriptor, contentVersion: "sha256:" + "c".repeat(64), processedMp4Url: "https://media.creatornet.net/feed-auto/" + "c".repeat(64) + ".mp4" };
  await act(async () => resolve({ ok: true, json: async () => replacement }));
  await render({ active: true, neighbor: false });
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(latest.descriptor).toEqual(replacement);
});
test("leaving the preparation window allows a fresh version lookup on return", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => descriptor });
  await render(); await render({ active: false, neighbor: false });
  expect(latest.descriptor).toBeNull();
  await render(); expect(fetchMock).toHaveBeenCalledTimes(2);
});
test.each([
  ["http-error", () => Promise.resolve({ ok: false, status: 503 }), 503, undefined],
  ["invalid-descriptor", () => Promise.resolve({ ok: true, status: 200, json: async () => ({ key: "wrong" }) }), 200, undefined],
  ["invalid-json", () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("sensitive message"); } }), 200, "SyntaxError"],
  ["fetch-error", () => Promise.reject(new TypeError("sensitive request URL")), null, "TypeError"],
  ["fetch-error", () => Promise.reject({ name: "sensitive-custom-name", message: "secret" }), null, "unknown"],
] as const)("resolver diagnostics report %s without raw error text", async (outcome, fetchResult, status, errorName) => {
  const record = jest.spyOn(diagnostics, "recordFeedEvent");
  fetchMock.mockImplementation(fetchResult);
  expect(await requestFeedPlayback(original).promise).toBeNull();
  const result = record.mock.calls.find(([kind]) => kind === "resolution-result")?.[1];
  expect(result).toEqual({ key, outcome, status, ...(errorName ? { errorName } : {}) });
  expect(JSON.stringify(result)).not.toMatch(/sensitive|secret/);
});
test("last-subscriber abort is observable and does not change the null-result API", async () => {
  const record = jest.spyOn(diagnostics, "recordFeedEvent");
  fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("sensitive", "AbortError")))));
  const request = requestFeedPlayback(original); request.cancel();
  expect(await request.promise).toBeNull();
  expect(record).toHaveBeenCalledWith("resolution-abort-requested", { key, reason: "no-subscribers" });
  expect(record).toHaveBeenCalledWith("resolution-result", { key, outcome: "aborted", status: null, errorName: "AbortError" });
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
