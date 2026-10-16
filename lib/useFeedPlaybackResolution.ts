"use client";
import { useEffect, useState } from "react";
import { mobilePlaybackDelivery, publicVideoKey, requestFeedPlayback, selectResolvedPlayback, type ResolvedFeedPlayback } from "./feedPlaybackResolution";
import { recordFeedEvent } from "./mobileFeedDiagnostics";

type Selection = { identity: string; source?: string; descriptor: ResolvedFeedPlayback | null; selected: boolean };
/** Resolution may delay a cold activation by at most one second. Selection is
 * pinned for that activation; a late response cannot replace a playing source. */
export function useFeedPlaybackResolution(input: { postId: string; original?: string; fallback?: string; mobile: boolean; controller: boolean; active: boolean; neighbor: boolean; visible: boolean; nativeHls: boolean }) {
  const { postId, original, fallback, mobile, controller, active, neighbor, visible, nativeHls } = input;
  const delivery = mobile ? mobilePlaybackDelivery(controller) : "off";
  const eligible = delivery !== "off" && !!publicVideoKey(original) && visible && (active || neighbor);
  const identity = `${postId}:${original ?? ""}:${delivery}`;
  const [selection, setSelection] = useState<Selection>({ identity: "", descriptor: null, selected: false });
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    // A new inactive preparation refreshes the version before another
    // activation can consume the preceding activation's selection.
    if (!active && selection.selected) setSelection({ identity, descriptor: null, selected: false });
  }
  if (!active && !eligible && selection.selected) setSelection({ identity, descriptor: null, selected: false });
  const valid = selection.identity === identity;
  useEffect(() => {
    if (!eligible || !original) return;
    // Fallback is a selection too: transfer it without a second lookup that
    // could replace a source already playing, including after visibility changes.
    if (active && valid && selection.selected) return;
    let alive = true, pinned = false;
    const request = requestFeedPlayback(original);
    recordFeedEvent("resolution-start", { postId, delivery });
    const choose = (descriptor: ResolvedFeedPlayback | null, reason: string) => {
      if (!alive || pinned) return;
      pinned = true;
      const source = descriptor ? selectResolvedPlayback(descriptor, delivery, nativeHls) : fallback;
      setSelection({ identity, source, descriptor, selected: true });
      recordFeedEvent("resolution-selected", { postId, reason, contentVersion: descriptor?.contentVersion ?? null, source: source ?? null, delivery });
    };
    const timer = setTimeout(() => { choose(null, "one-second-timeout"); request.cancel(); }, 1_000);
    void request.promise.then(descriptor => { clearTimeout(timer); choose(descriptor, descriptor ? "resolved" : "ordinary-fallback"); });
    return () => { alive = false; clearTimeout(timer); request.cancel(); };
    // Source changes inside an activation are owned by recovery, never a late lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, identity, original, active, nativeHls, delivery]);
  return { descriptor: valid ? selection.descriptor : null, source: valid && selection.selected ? selection.source : fallback,
    waiting: eligible && (!valid || !selection.selected), delivery };
}
