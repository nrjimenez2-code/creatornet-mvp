"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import MobileFeedDiagnostics from "@/components/MobileFeedDiagnostics";
// Comparison wiring is confined to this lab; normal feed imports stay unchanged.
import { MobileFeedController as CurrentController } from "@/lib/mobileFeedController";
import { MobileFeedController as RateController } from "@/lib/mobileFeedController.prototype";
import { mobileFeedPlaybackReady, mobileFeedSeekFailed } from "@/lib/mobileFeedPlayer";
import { feedTraceEnabled, observeFeedScroll, recordFeedEvent, setFeedRunContext } from "@/lib/mobileFeedDiagnostics";
import type { PlaybackFormat } from "@/lib/playbackFormatFixtures";

export type PlaybackFixture = { id: string; label: string; src: string; contentVersion: string };
type Owner = { token: symbol; video: HTMLVideoElement; postId: string; terminal: boolean };
type Presentation = { postId: string; preview: boolean; ready: boolean; error: string | null };

const subscribeCapabilities = () => () => {};
const nativeHlsSnapshot = () => !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
const nativeMp4Snapshot = () => !!document.createElement("video").canPlayType("video/mp4");
const visibleSnapshot = () => !document.hidden;
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};

export default function PlaybackLab({ fixtures, buildCommit, controllerMode, sourceFormat }: { fixtures: PlaybackFixture[]; buildCommit: string; controllerMode: "current" | "rate" | "prearmed" | "steady" | "guarded" | "single" | "serial"; sourceFormat?: PlaybackFormat }) {
  const [controller] = useState(() => controllerMode === "current" ? new CurrentController()
    : new RateController(controllerMode === "rate" ? "reactive" : controllerMode === "single" ? "steady" : controllerMode));
  const isHls = sourceFormat === undefined || sourceFormat === "hls";
  const nativePlayback = useSyncExternalStore(subscribeCapabilities, isHls ? nativeHlsSnapshot : nativeMp4Snapshot, () => null);
  const sourceLabel = sourceFormat === "original" ? "original MP4" : sourceFormat === "mp4" ? "processed MP4" : "direct native HLS";
  const debug = useSyncExternalStore(subscribeCapabilities, feedTraceEnabled, () => false);
  const [started, setStarted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [muted, setMuted] = useState(true);
  const [playingIntent, setPlayingIntent] = useState(false);
  const visible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => true);
  const [retry, setRetry] = useState({ postId: "", version: 0 });
  const [presentations, setPresentations] = useState<Record<string, Presentation>>({});
  const [status, setStatus] = useState("Press Play to start muted. Tap for sound when ready.");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sections = useRef<Array<HTMLElement | null>>([]);
  const mainHosts = useRef<Array<HTMLDivElement | null>>([]);
  const preparationHosts = useRef<Array<HTMLDivElement | null>>([]);
  const owner = useRef<Owner | null>(null);
  const consumedRetryVersion = useRef(0);
  const lastActivatedPostId = useRef<string | null>(null);
  const mutedRef = useRef(muted);
  const intentRef = useRef(playingIntent);
  const activeIndexRef = useRef(activeIndex);
  const unmounting = useRef(false);

  const updatePresentation = useCallback((postId: string, patch: Partial<Presentation>) => {
    setPresentations(previous => ({ ...previous, [postId]: {
      ...(previous[postId] ?? { postId, preview: false, ready: false, error: null }), ...patch,
    } }));
  }, []);

  const fail = useCallback((owned: Owner, message: string) => {
    if (owner.current !== owned || owned.terminal) return;
    owned.terminal = true;
    recordFeedEvent("lab-terminal-failure", { reason: message }, owned.video);
    controller.suspend();
    // Media/seek failures end a still-live activation while preserving Retry's
    // target. A watchdog-stopped owner stays attached until its trace is recorded.
    if (controller.canPlay(owned.token)) controller.release(owned.token, false);
    else owned.video.pause();
    updatePresentation(owned.postId, { preview: false, ready: false, error: message });
    setStatus(message);
  }, [controller, updatePresentation]);

  const playOwned = useCallback((owned: Owner) => {
    if (owner.current !== owned || owned.terminal || !controller.canPlay(owned.token) || document.hidden || !intentRef.current) return;
    if (mobileFeedSeekFailed(owned.token)) { fail(owned, "The requested position could not load. Export the trace before Retry."); return; }
    owned.video.muted = mutedRef.current;
    recordFeedEvent("play-request", { muted: owned.video.muted, retried: false }, owned.video);
    const request = owned.video.play();
    controller.playRequested(owned.token);
    void request?.catch((error: unknown) => {
      if (owner.current !== owned || owned.terminal || !controller.canPlay(owned.token)) return;
      const name = error instanceof DOMException ? error.name : "PlaybackError";
      setStatus(`${name}: tap Play again. Export the trace if it persists.`);
    });
  }, [controller, fail]);

  const playWhenReady = useCallback((owned: Owner) => {
    if (owned.terminal || owner.current !== owned) return;
    const pending = mobileFeedPlaybackReady(owned.token);
    if (pending) void pending.then(() => playOwned(owned)); else playOwned(owned);
  }, [playOwned]);

  useEffect(() => {
    setFeedRunContext({ feed: sourceFormat ? "preview-playback-format-lab" : "preview-hls-controller-lab", mode: "candidate", buildCommit, labBuildCommit: buildCommit,
      labController: controllerMode, labFormat: sourceFormat ?? "hls", labFixtureSet: sourceFormat ? "carlos-noah-v1" : "legacy-hls",
      surface: sourceFormat ? `Preview / playback format lab / ${sourceFormat} / ${controllerMode}` : `Preview / direct HLS controller lab / ${controllerMode}` });
  }, [buildCommit, controllerMode, sourceFormat]);

  useLayoutEffect(() => { unmounting.current = false; return () => { unmounting.current = true; }; }, []);

  useLayoutEffect(() => {
    const fixture = fixtures[activeIndex];
    const host = mainHosts.current[activeIndex], previewHost = preparationHosts.current[activeIndex];
    if (!started || !nativePlayback || !fixture || !host || !previewHost) return;
    // Production resets a manual pause when the active post changes. A render or
    // source effect for the same post must preserve the user's current intent.
    if (lastActivatedPostId.current !== null && lastActivatedPostId.current !== fixture.id) {
      intentRef.current = true; setPlayingIntent(true);
    }
    lastActivatedPostId.current = fixture.id;
    const token = Symbol(fixture.id);
    const reload = retry.postId === fixture.id && retry.version > consumedRetryVersion.current;
    if (reload) consumedRetryVersion.current = retry.version;
    setStatus("Watch this clip, then swipe to the next. Export the trace before any Retry.");
    updatePresentation(fixture.id, { preview: false, ready: false, error: null });
    const update = (patch: Partial<Presentation>) => updatePresentation(fixture.id, patch);
    let owned: Owner | null = null;
    const video = controller.activate({ postId: fixture.id, src: fixture.src, contentVersion: fixture.contentVersion,
      host, previewHost, token, present: preview => update({ preview }), ready: () => update({ ready: true }),
      failed: () => { if (owned) fail(owned, "This video could not load. Export the trace before Retry."); },
      reload });
    owned = { token, video, postId: fixture.id, terminal: false };
    const activatedOwner = owned;
    owner.current = owned;
    video.className = "absolute inset-0 h-full w-full object-cover";
    video.preload = "auto";
    video.muted = mutedRef.current;
    const mediaError = () => {
      if (activatedOwner.terminal || !controller.canPlay(token)) return;
      recordFeedEvent("lab-media-error", { code: video.error?.code ?? null }, video);
      fail(activatedOwner, "The HLS source reported a media error. Export the trace before Retry.");
    };
    video.addEventListener("error", mediaError);
    playWhenReady(activatedOwner);
    return () => {
      video.removeEventListener("error", mediaError);
      if (owner.current === activatedOwner) owner.current = null;
      controller.release(token, activeIndexRef.current !== activeIndex || unmounting.current);
      updatePresentation(fixture.id, { preview: false, ready: false });
    };
  }, [activeIndex, controller, fail, fixtures, nativePlayback, playWhenReady, retry, started, updatePresentation]);

  useLayoutEffect(() => {
    // Single-player control keeps the same shared main, sources and layout,
    // but never creates or plays a prepared neighbor or presentation bridge.
    if (controllerMode === "single" || !started || !nativePlayback || !visible || owner.current?.terminal) { controller.cancelPreparation(); return; }
    const neighborIndex = activeIndex + direction;
    const neighbor = fixtures[neighborIndex], host = preparationHosts.current[neighborIndex];
    if (!neighbor || !host) { controller.cancelPreparation(); return; }
    // Activation consumes the previous neighbor before this selects its successor.
    controller.prepare({ postId: neighbor.id, src: neighbor.src, contentVersion: neighbor.contentVersion, host,
      present: preview => updatePresentation(neighbor.id, { preview }) });
  }, [activeIndex, controller, controllerMode, direction, fixtures, nativePlayback, retry, started, updatePresentation, visible]);

  useEffect(() => {
    const visibility = () => {
      if (document.hidden) { controller.suspend(); owner.current?.video.pause(); }
      else if (owner.current) playWhenReady(owner.current);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); controller.dispose(); };
  }, [controller, playWhenReady]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !started) return;
    let previousScroll = root.scrollTop;
    const ratios = new Map<Element, IntersectionObserverEntry>();
    const observer = new IntersectionObserver(entries => {
      const delta = root.scrollTop - previousScroll;
      if (Math.abs(delta) > 1) setDirection(delta > 0 ? 1 : -1);
      previousScroll = root.scrollTop;
      entries.forEach(entry => {
        ratios.set(entry.target, entry);
        recordFeedEvent("visibility", { postId: (entry.target as HTMLElement).dataset.postId ?? "", ratio: entry.intersectionRatio });
      });
      const selected = [...ratios.values()].filter(entry => entry.isIntersecting && entry.intersectionRatio >= 0.51)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const index = selected ? sections.current.indexOf(selected.target as HTMLElement) : -1;
      if (index >= 0) {
        // Update before React runs the departing activation's cleanup.
        activeIndexRef.current = index; setActiveIndex(index);
      }
    }, { root, threshold: [0, 0.08, 0.49, 0.51, 0.92, 1] });
    sections.current.forEach(section => { if (section) observer.observe(section); });
    const stopScrollTrace = observeFeedScroll(root, "preview-hls-controller-lab");
    return () => { observer.disconnect(); stopScrollTrace(); };
  }, [started]);

  const navigate = (step: number) => {
    const next = activeIndex + step;
    if (!started || next < 0 || next >= fixtures.length) return;
    setDirection(step);
    sections.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const play = () => {
    if (owner.current?.terminal) return;
    intentRef.current = true; setPlayingIntent(true);
    if (!started) setStarted(true); else if (owner.current) playWhenReady(owner.current);
  };
  const pause = () => { intentRef.current = false; setPlayingIntent(false); owner.current?.video.pause(); };
  const sound = () => {
    const owned = owner.current;
    if (!owned || owned.terminal || !controller.canPlay(owned.token)) return;
    mutedRef.current = !mutedRef.current; setMuted(mutedRef.current);
    owned.video.muted = mutedRef.current;
    recordFeedEvent("sound-state", { muted: owned.video.muted, volume: owned.video.volume, outputMeasured: false }, owned.video);
    if (intentRef.current) playWhenReady(owned);
  };
  const activeId = started ? fixtures[activeIndex]?.id ?? null : null;
  const activePresentation = activeId ? presentations[activeId] : undefined;

  return <main className="fixed inset-0 z-50 bg-black text-white">
    <div className="relative mx-auto h-full max-w-[430px]">
      <div ref={scrollRef} className="h-full overflow-y-scroll snap-y snap-mandatory [scrollbar-width:none]"
        style={{ overscrollBehaviorY: "contain", touchAction: "pan-y pinch-zoom" }}>
        {fixtures.map((fixture, index) => {
          const shown = presentations[fixture.id];
          return <section key={fixture.id} data-post-id={fixture.id} ref={element => { sections.current[index] = element; }}
            className="relative h-[100dvh] w-full snap-start snap-normal overflow-hidden bg-black">
            <div className="relative h-full w-full overflow-hidden">
              <div ref={element => { mainHosts.current[index] = element; }} className="absolute inset-0 h-full w-full" />
              <div ref={element => { preparationHosts.current[index] = element; }} className="pointer-events-none absolute inset-0 z-10 h-full w-full" />
              {!(shown?.preview || shown?.ready) && <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-br from-[#232039] via-[#151325] to-[#07070c]" />}
              {shown?.error && <div role="alert" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
                <p>{shown.error}</p>
                <button className="rounded border px-4 py-2" onClick={() => { intentRef.current = true; setPlayingIntent(true); setRetry(previous => ({ postId: fixture.id, version: previous.version + 1 })); }}>Retry video</button>
              </div>}
              <p className="pointer-events-none absolute bottom-36 left-4 z-30">{fixture.label} · {sourceLabel}</p>
            </div>
          </section>;
        })}
      </div>
      {debug && <MobileFeedDiagnostics activePostId={activeId} getVideo={id => owner.current?.postId === id ? owner.current.video : null} />}
      <div className="absolute bottom-0 left-0 right-0 z-40 space-y-2 bg-black/90 p-3 text-sm">
        <p>{sourceFormat ? "Preview format comparison" : "Preview controller experiment"} · {controllerMode} · {sourceFormat && `${sourceFormat} · `}{buildCommit.slice(0, 12)}</p>
        <p role="status">{nativePlayback === false ? `This browser does not report native ${isHls ? "HLS" : "MP4"} support.` : status}</p>
        <div className="flex flex-wrap gap-2">
          <button disabled={nativePlayback !== true || !!activePresentation?.error} className="rounded border px-3 py-2 disabled:opacity-40" onClick={play}>Play</button>
          <button disabled={!started} className="rounded border px-3 py-2 disabled:opacity-40" onClick={pause}>Pause</button>
          <button disabled={!started || !!activePresentation?.error} className="rounded border px-3 py-2 disabled:opacity-40" onClick={sound}>{muted ? "Tap for sound" : "Mute"}</button>
          <button disabled={!started || activeIndex === 0} className="rounded border px-3 py-2 disabled:opacity-40" onClick={() => navigate(-1)}>Previous</button>
          <button disabled={!started || activeIndex >= fixtures.length - 1} className="rounded border px-3 py-2 disabled:opacity-40" onClick={() => navigate(1)}>Next</button>
        </div>
        <p>Use physical swipes for playback measurements. Next/Previous are functional checks.</p>
        <p>{debug ? "Capture controls → Export trace. Export before Retry; keep the run unreset." : "Open this route with ?feedDebug=1 to capture and export diagnostics."}</p>
      </div>
    </div>
  </main>;
}
