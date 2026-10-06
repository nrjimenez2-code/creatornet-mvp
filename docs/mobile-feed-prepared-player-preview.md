# Prepared player Preview experiment

Status: prepared control published; paused-audio control local. Physical
sound/grant/continuity/performance acceptance remains pending.
The normal feed and existing format comparisons keep their defaults.

The Preview-only route `/playback-formats?format=mp4&transfer=prepared&feedDebug=1`
opts into the existing closed Carlos/Noah processed-MP4 pair. Other formats cannot
use this selector, and the route returns not-found outside `VERCEL_ENV=preview`.
Its footer and exported context identify `prepared` plus the exact build commit.
Use an immutable deployment only after exact-head publication approval and full CI.

The separate `transfer=prepared-audio` selector keeps these same Preview/MP4/source
restrictions and reports `prepared-audio` in its footer and exported controller/
transfer context. Preparation still decodes muted. Only after qualified preparation
has paused, and the current moving main's unmuted native play has resolved, can this
control leave the paused neighbor unmuted before selection. No preparation play,
load, seek, rate change or extra gesture is added at that point. Pause, mute,
pending/rejected main play, background, cancellation and expiry revoke that state.
Selection rechecks current sound/play intent and every existing promotion guard;
the default `prepared` control still rejects unexpected unmuted preparation.
The departing main is paused/muted before the promoted element can play. At most
one element can be playing unmuted; no second active audio timeline is introduced.

This is an audio-startup hypothesis, not a demonstrated fix. Current upstream
[WebKit AVFoundation code](https://github.com/WebKit/WebKit/blob/60582f61a44ec4d1ad1c3b7ae313868be8249eda/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm#L2310-L2337)
updates audio suppression/system-audio connection when mute changes. That source
does not identify the owner's installed Safari binary or prove the cause of the
captured gap. A momentary unmute followed by remute while paused would restore
suppression in that implementation, so this control retains the paused state
until promotion or revocation. A resolved unmuted play permits the local control;
it does not prove audible output, transferred permission or native audio readiness.
Permission denial still records failure and requires an explicit recovery gesture.
With diagnostics enabled, `preparation-sound-state` records paused/mute state and
selection reports `preparationAudio`; these are properties, not acoustic metrics.

The 8511b88 Safari capture retained a 374.875ms recorded audio gap. Synchronous
old-source retirement/attachment took 1ms, main play returned after 75ms and
resolved after 94ms, and moving/handoff callbacks arrived after 210/211ms. Original
stereo verification found both channels exactly zero in the gap's interior while
the aligned source contains opening sound. The later matched picture/audio segment
had no supported backward step; this single warm attempt fails continuity and is
not a p95 cohort. Native audio startup remains unproven. Compare this new control
against `prepared` on an exact approved build without pooling their cohorts.

A qualified paused, muted, 1x preparation can become the sole active player. Its
literal source, current source, content version, fixed departure snapshot, target,
frame, dimensions and buffer are checked again at selection. The departing owner
is paused/revoked and its position saved first; its source is then retired. Promotion
cancels preparation callbacks and removes the slot without reloading, assigning the
source again, seeking forward or changing playback rate. Selected partial/stale/
expired preparation and Retry take the shared-player cold path without a bridge.
Before five seconds a valid saved target can resume; at or after five seconds it
restarts. Reads, preparation and Retry never extend the original departure deadline.

This changes the sound element's identity on eligible warm selection. It does not
assume that the departing element's WebKit grant transfers. The lab applies current
mute/play intent and observes the existing native play promise even with diagnostics
off. Rejection remains a failed attempt. Permission denial pauses playback, restores
the explicit Tap for sound/Play action and prevents automatic foreground retry.
Other native/media/seek failures require explicit Retry. Keep the failed export
before trying either action; gesture recovery does not erase or qualify the failure.
A fulfilled promise, unmuted property or frame callback is not measured sound output.

With `feedDebug=1`, prepared selection records its request timestamp and selection
duration. The existing transfer event adds cumulative return times for departing
pause, mute, trace cleanup, source removal, load and detach, followed by promoted
attachment. Handoff also reports time from the selection request. These passive
timestamps expose synchronous retirement work that preceded the existing activation
trace; they do not measure native audio drain/admission or change media calls,
ownership, watchdog deadlines or readiness. The existing `activationMs` keeps its
original origin. A recorded output gap remains a failed continuity result even if
unmuted native play resolves and later picture/audio match.

Readiness requires source/target-qualified advancing frames with finite advancing
frame counts, fresh submissions and accepted native playback. The three-second
watchdog keeps the automatic activation deadline, including return-seek waiting;
intentional pause/background cancels it, and resumed playback rearms it. One active
element plus at most one preparation slot is retained. Decoding remains muted;
only the explicit audio control may unmute a qualified paused slot.
Neighbor decoding waits for qualified active motion. Disposal and
expiry operate only on still-owned preparation; a promoted slot cannot unload the
active video. Released active video uses the ordinary five-second parked lifecycle.
Source removal and mocked element counts do not prove immediate native decoder release.

Local tests cover promotion without reload/seek, token/callback revocation, exact
return boundaries, stale-source/content/target/clock/rate/buffer/frame rejection,
denied play, pause/background/Retry, repeated ownership and branch cleanup. Run these
with the affected player, snapshot, prototype, lab and format-server suites, scoped
lint and TypeScript. Full CI remains required before hosted testing.

Keep the full acceptance gates in `mobile-feed-phone-acceptance.md` and
`mobile-feed-safari-acceptance.md`: physical iPhone Safari/Instagram, Discover/Following,
moving picture and actual sound, initial grant and no repeated sound prompt, strict
returns, controls, profile/background, source/rendition qualification, resources,
matching TikTok conditions and the required sample/performance thresholds. This
two-fixture Preview experiment alone cannot satisfy normal-feed or Production gates.
