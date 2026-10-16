import { mobileFeedController } from "./mobileFeedController";
import { PreparedMobileFeedController } from "./mobileFeedPreparedController";

export type MobileFeedHandoff = boolean | "prepared-preload-audio";
type Controller = typeof mobileFeedController | PreparedMobileFeedController;

// Supported mobile feeds use paused preparation by default, with immediate cleanup.
const preparedController = new PreparedMobileFeedController("prepared-preload-audio");
let handoffForThisPageSession: MobileFeedHandoff = "prepared-preload-audio";
let liveReadoutForThisPageSession = true;

export function resolveMobileFeedHandoff(search: string, previous: MobileFeedHandoff = "prepared-preload-audio"): MobileFeedHandoff {
  const params = new URLSearchParams(search);
  const bridge = params.get("feedBridge"), transfer = params.get("feedTransfer");
  let selected = bridge === null ? previous : bridge === "1";
  if (transfer !== null) selected = transfer === "prepared-preload-audio" ? transfer : false;
  return selected;
}

export function mobileFeedHandoffSnapshot(): MobileFeedHandoff {
  if (typeof window === "undefined") return false;
  handoffForThisPageSession = resolveMobileFeedHandoff(window.location.search, handoffForThisPageSession);
  // Prepared startup requires advancing frame callbacks. Older browsers retain
  // conventional playback instead of reaching the prepared startup watchdog.
  if (handoffForThisPageSession === "prepared-preload-audio" &&
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== "function") return false;
  return handoffForThisPageSession;
}

export function normalFeedController(handoff: MobileFeedHandoff | undefined): Controller {
  return handoff === "prepared-preload-audio" ? preparedController : mobileFeedController;
}

export function mobileFeedReadoutSnapshot(): boolean {
  if (typeof window === "undefined") return true;
  const requested = new URLSearchParams(window.location.search).get("feedReadout");
  if (requested !== null) liveReadoutForThisPageSession = requested !== "0";
  return liveReadoutForThisPageSession;
}

/** Observe every main play attempt, including gestures and muted policy fallback.
 * A fulfilled promise permits frame qualification; it does not measure sound. */
export function playNormalFeedVideo(controller: Controller | undefined, token: symbol, video: HTMLVideoElement): Promise<void> {
  if (controller && !controller.canPlay(token)) return Promise.reject(new DOMException("Obsolete feed activation", "AbortError"));
  const requestedAt = controller instanceof PreparedMobileFeedController ? performance.now() : 0;
  let request: Promise<void>;
  try { request = video.play(); } catch (error) { request = Promise.reject(error); }
  if (controller instanceof PreparedMobileFeedController) {
    controller.observeMainPlay(token, { requestedAt, returnedAt: performance.now(), request });
  }
  controller?.playRequested(token);
  return request;
}

export function pauseNormalFeedVideo(controller: Controller | undefined, token: symbol, video: HTMLVideoElement) {
  if (controller instanceof PreparedMobileFeedController) controller.pauseRequested(token);
  video.pause();
}

export function updateNormalFeedSound(controller: Controller, token: symbol) {
  if (controller instanceof PreparedMobileFeedController) controller.soundChanged(token);
}
