# Prepared player Preview experiment

Status: paused preload published in draft PR #248 at 20bb6b8; earlier
prepared/audio/in-place controls were published at 1550d6f.
Two digital captures omit about 354ms of non-silent opening source audio. An
external retained-player capture with owner-confirmed screen recording off,
Low Power Mode off and speaker output also contains very weak opening audio.
The direct-player camera control captures that opening, but main motion starts
at 940ms, behind its muted bridge; the 3000ms watchdog recovers without alignment.
These are separate individual failures, not a controlled performance cohort or
proof of a native cause. Two new 20bb6b8 trials qualify paused preload and retained
promotion with zero preparation plays. The recorded trial includes the formerly
missing opening audio; the unrecorded owner reports good opening sound and sync.
Advancing callbacks still take 403/544ms and qualified handoff 471/611ms. These
individual results leave startup smoothness and native cause unresolved. The
pipeline timing supplement below is local only and has no publication approval.
Sound/grant/continuity/performance acceptance remains pending.
The normal feed and existing format comparisons keep their defaults.

## Paused preload comparison

`transfer=prepared-preload-audio` is a separate Preview-only fixed processed-MP4
control. It retains the connected preparation host and existing paused-audio
policy, but never calls `play()` during preparation. Once the same main-player
motion/buffer budget admits preparation, it registers a video-frame callback
before assigning/loading the source. The existing exact target, actual frame,
source, snapshot, dimensions and buffer checks still qualify the paused slot.
Metadata/loadeddata alone, an advancing clock or a promise cannot qualify it.
Progress, seek completion and both bounded preparation attempts cannot play it.
If no qualifying paused-load frame arrives, existing bounded cancellation and
cold main fallback remain; do not weaken the checks to manufacture eligibility.

Only the selected main receives its first play request, after sole-owner transfer
and existing old-source retirement. It still needs accepted play and fresh
advancing source-qualified frames within the unchanged 3000ms watchdog. Mute,
pause, background, denial, expiry and cancellation retain the same revocations.
No extra decoder, deferred old-source cleanup, rate/session/microphone action or
forward seek is introduced. Saved-position preparation retains its existing
snapshot-target positioning. Export identifies `prepared-preload-audio`,
`preparationPlayback:paused-load` and retained attachment; an eligible trial must
also show preparation `playRequestCount:0` and an actual qualified target frame.

This tests whether prior muted play/pause history contributes to opening loss.
[WebKit's frame-loading guidance](https://bugs.webkit.org/show_bug.cgi?id=236604#c2)
supports installing the callback before loading; it does not establish that this
phone, hidden preparation host or native sound pipeline will qualify or improve.
Pausing preload also postpones source load until the existing budget admits it.
One recorded and one owner-observed unrecorded trial now establish native
eligibility for those attempts; broad sound/performance/reliability acceptance
remains unproven.
Local checks cannot replace exact-head CI/Preview and a new original external
camera/JSON comparison. New-head publication needs separate exact approval.

## Local startup pipeline timing supplement

20bb6b8 trace 1791504741148 is contiguous/monotonic, zero-drop and unreset. The
owner confirmed recording off, Low Power Mode off and phone speaker. Noah was
ready at source target zero with 48.491s buffered, no preparation plays, unchanged
source and retained attachment. Selection took 1ms, native `play()` returned after
94ms and its promise settled at request+180ms. First callback delivery was +511ms,
advancing trace callback +544ms, qualified handoff +611ms; callbacks still arrived
and no watchdog or playback rejection occurred. The first two submissions were
133/135ms old. This reproduces the startup catch without recording, but two
uncontrolled runs do not quantify a recorder effect, physical display latency or
p95. The native reason remains unknown.

The local supplement adds raw `presentationTime`, `expectedDisplayTime`,
`processingDuration`, `width` and `height` to the existing first-eight
`lab-main-startup-frame` samples under `feedDebug=1`. Missing/nonfinite values
remain null. It adds no callback or media call and changes no qualification,
ownership, permission, source-retirement, paused-preparation, budget, return or
watchdog policy. Future expected display time cannot qualify a stale submission.

The [frame-callback specification](https://wicg.github.io/video-rvfc/) distinguishes
submission time, expected display time and optional packet-to-decoded-frame
processing duration; callback delivery has no strict timing guarantee. These
fields can distinguish reported pipeline stages on the next approved diagnostic
build. They do not identify the installed native cause or prove acoustic/display
output, and this supplement does not fix the measured startup catch.

## Published controls and historical observations

The `transfer=prepared-inplace-audio` comparison preserves the paused-audio
policy of `prepared-audio` while keeping a promoted video in its connected
preparation host. It rejects wrong/disconnected placement before retiring the
departing source. Eligible adoption omits the DOM append; source, target,
permission, buffer, fresh-frame, sole audible owner, return and watchdog guards
remain required. Cold, ineligible and explicit Retry still use the ordinary main
host. Retired source cleanup retains its existing order and media calls.
The lab's preparation/main hosts have the same picture geometry; the promoted
video becomes the sole main owner and leaves preparation bookkeeping.

This tests whether reparenting a qualified prepared element disrupts native state;
it does not prove that reparenting caused the captured sound loss. No extra
play/load/seek/rate, audio-session or microphone action is added. The new selector
remains restricted to Preview and the same fixed processed-MP4 pair, with its own
footer/export context. Debug trace reports `preparedAttachmentRetained` on
selection and successful transfer. Existing `prepared-audio` remains available
for a comparison on the same build; never pool their physical results.

The latest 505c543 capture retains ~460ms of original stereo silence. The source's
own opening is quiet until about 0.151s, but source audio from approximately
0.151..0.504s is absent in the recording. Two delivered source-qualified
controller callbacks and a successful handoff do not establish audio continuity
or explain the prior intermittent missing-callback failure. Local tests cannot
validate either native hypothesis. New exact-head publication approval, full CI,
matched Ready Preview and separate physical captures are required before this
local comparison can be evaluated as a playback change.

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

Two 63ef2c0 Safari/iPhone 17 Pro Max captures retain the failed attempts. With
owner-confirmed Low Power Mode on, the original stereo startup gap was about
450ms; the off capture retained about 380ms. Both aligned source intervals contain
opening sound. These individual captures do not establish a power-mode effect.
The off capture exported 104 contiguous events with zero drops: selected source
unchanged, paused-unmuted preparation promoted, play resolved after 88ms, but no
Noah startup-frame callbacks or handoff. At three seconds the existing watchdog
paused playback and displayed the error. Its recording shows source-corresponding
moving Noah picture before that stop; the native cause and callback delivery state
remain unknown. Do not interpret the advancing clock as qualified readiness.

With `feedDebug=1`, the published diagnostics sample the first eight controller frame
requests and record pending handle/age, delivery/discard/cancellation counts and
the last discard/cancellation reason at native play settlement and timeout. The
timeout also reads playback-quality counters and connection/visibility/media
state before its own pause. Unsupported quality reads remain null. These data
distinguish a pending callback from one discarded by owner/epoch checks. Existing
readiness, callback scheduling, play/pause/load/seek calls, rate and watchdog
behavior stay unchanged. The successful 505c543 capture shows callback delivery
for that attempt; it cannot explain the earlier failure. The new local in-place
comparison retains these diagnostics and needs its own approved publication and
physical evidence.

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
