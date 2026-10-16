# Prepared player Preview experiment

October 15 release status: the full feed release now selects paused prepared playback by default on supported mobile Discover/Following; explicit opt-out, unsupported-browser fallback and desktop isolation remain available. Remaining manual phone/performance/resource/TikTok acceptance is owner-waived and unverified, not passed. See `mobile-feed-controlled-release.md`. The experiment checkpoints below remain historical; lab-only variants retain their Preview gates.

Current checkpoint: f653350 is published in draft PR #248. Four unrecorded
phone traces and one recorded trace retain fully buffered paused preparation,
zero preparation plays and immediate selected-main play. A stable live-readout
advantage was not demonstrated; the recorded opening speech is complete.
Startup still catches. These five transitions do not establish physical p95,
continuous acoustic sync, normal-feed readiness or LIVE acceptance.

The new `retire=after-startup` comparison below is a local Preview hypothesis
pending its own checks, exact-head CI/Preview and phone result. Existing defaults
and the normal feed remain unchanged. Earlier publication-status paragraphs
below describe their historical checkpoints; the newest handoff governs scope.

## Departing-source retirement comparison

Use `/playback-formats?format=mp4&transfer=prepared-preload-audio&retire=after-startup&feedDebug=1&feedReadout=0`
only on the exact verified Preview build. Omit `retire` for the same-build
immediate-retirement baseline. The route rejects other retirement values,
formats and transfer modes, and remains unavailable outside Preview.

Hypothesis: unloading the departing source immediately before selected-main
play may contribute native startup work. The current code removes its source,
calls `load()` and detaches it before play. The
[HTML media load algorithm](https://html.spec.whatwg.org/multipage/media.html#media-element-load-algorithm)
resets the element's resource processing; it does not establish cross-element
contention or identify the installed Safari cause. This experiment moves those
three cleanup operations past fresh advancing startup qualification. It adds
no delay to selected play and does not play, seek or reload the prepared source.

The departing owner is still revoked, paused, muted and untraced before the
successor can play. It stays parked with its source for at most 3000ms. The
retained source occupies the existing second-element budget: requested neighbor
preparation is queued without creating a third video. Qualified startup clears
the old source before admitting the latest neighbor. Pause, background,
rejection, stop, release, Retry and another shared-player claim also clear it.
An independent deadline bounds retention even when no play request occurs.
Existing play permission, source/snapshot/target/frame freshness/advancement,
opening audio, return boundary and startup watchdog checks remain required.

Exports distinguish `labRetiredSourceCleanup:after-startup` from `immediate`.
Selection/transfer record whether the old source is pending;
`prepared-source-retired` records the cleanup reason. Existing native-play,
submission, callback and handoff timing samples stay in use. Successful tests
prove ordering, ownership and resource bounds in mocked media only. A new
same-build phone comparison must show eligible paused preparation, unchanged
opening target, complete sound and the intended retirement ordering before
assessing startup. Callback changes alone do not prove physical display/audio
improvement, a native cause or the original full acceptance matrix.

## Historical paused-preload checkpoint

Status at the earlier checkpoint: paused preload published in draft PR #248 at 20bb6b8, with passive
startup pipeline diagnostics published at c03e525; earlier
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
capture-only readout comparison below is local only and has no publication approval.
Sound/grant/continuity/performance acceptance remains pending.
The normal feed and existing format comparisons keep their defaults.

## Local capture-only readout comparison

The c03e525 unrecorded trace 1791507631417 qualifies paused-load preparation with
zero preparation plays and retained promotion. It reports moving trace callback
+402ms and qualified handoff +469ms from selection; the owner reports good sound
and sync with an initial catch. With diagnostics off, the owner subsequently
reports a much smoother start. In two further fresh-tab diagnostics-off runs,
the owner confirms a slight remaining catch, complete synchronized opening words,
screen recording off, Low Power Mode off and phone speaker output. These last
two observations have no JSON or recording and establish neither exact physical
timing, matched statistical performance nor the cause of the improvement.

The local comparison keeps `feedDebug=1` and adds `feedReadout=0` only to the
Preview fixed processed-MP4 `transfer=prepared-preload-audio` pair. All trace
observers, controller samples and capture/export controls remain. The live
readout's media-property polling and displayed post/buffer/frame readings stop;
the collapsed overlay retains a static Capture controls button. Hide the controls
before swiping, then reopen them to export without resetting. Trace context labels
`labDiagnosticReadout` as `live`, `capture-only` or `off` so cohorts stay distinct.
Omitted or non-exact readout parameters preserve the live readout, and other
format/transfer comparisons keep their existing behavior.

This isolates the live readout from the remaining tracing work. It is not a
playback fix: source/target/frame/ownership/permission qualification, zero-play
preparation, source retirement, decoder budget, exact return boundary and watchdog
are unchanged. Native cause and full sound/physical/performance/LIVE acceptance
remain open. Local checks and a fresh exact-head publication approval are required
before this comparison can be tested on the phone.

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

## Published startup pipeline timing supplement

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

The published supplement adds raw `presentationTime`, `expectedDisplayTime`,
`processingDuration`, `width` and `height` to the existing first-eight
`lab-main-startup-frame` samples under `feedDebug=1`. Missing/nonfinite values
remain null. It adds no callback or media call and changes no qualification,
ownership, permission, source-retirement, paused-preparation, budget, return or
watchdog policy. Future expected display time cannot qualify a stale submission.

The [frame-callback specification](https://wicg.github.io/video-rvfc/) distinguishes
submission time, expected display time and optional packet-to-decoded-frame
processing duration; callback delivery has no strict timing guarantee. These
fields can distinguish reported pipeline stages in each diagnostic capture.
They do not identify the installed native cause or prove acoustic/display
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

## Original Noah startup source control

The completed `22e538d` A1/B1/B2/A2 cleanup comparison found no demonstrated
startup benefit from delayed source retirement. Keep immediate cleanup as the
engineering baseline and do not repeat that comparison.

The existing, exact-byte media audit and saved decode logs expose a new source
question. Processed Noah begins I/B/B/B/P and reports x264 `bframes=3`; original
Noah begins I/P/P/P/P, with no B-frames in its complete saved frame log. Both
start at media time zero. The original is 752x1176, 30 fps, 48 kHz AAC-LC and
20,875,511 bytes; processed is 720x1124, 30 fps, 48 kHz AAC-LC and 11,071,255
bytes. The original has one-second keyframe gaps and its moov atom at the end;
processed has fast-start layout and gaps up to 8.333334 seconds. The saved
timeline comparison finds matching video PTS and closely aligned audio, without
awarding runtime cross-rendition resume proof.

[Apple's low-latency encoding explanation](https://developer.apple.com/videos/play/wwdc2021/10158/)
discusses removing frame reordering in real-time encoding. It supports examining
this difference, not attributing this fully buffered Safari startup to B-frames
or predicting a latency saving. Resolution, bitrate, GOP, audio encoding and
container layout also differ. Encoder lookahead is completed before VOD playback;
do not count its configured frames as a playback delay.

On a newly verified exact-head Preview, append `noahSource=original` to
`/playback-formats?format=mp4&transfer=prepared-preload-audio&feedDebug=1&feedReadout=0`.
Only Noah uses its already existing audited original MP4; Carlos stays processed.
Omitting the parameter keeps both processed sources. The server rejects other
source values, modes, formats and combined retirement controls. Production remains
unavailable. No new media, imports, downloads, transcodes or provider changes are
part of this control.

The page labels Noah's actual format and the separate source comparison. Export
context identifies `labStartupSource=noah-original` and
`labFixtureSet=carlos-processed-noah-original-v1`. Original Noah retains its
separate original-rendition post ID/content version, so a processed resume target
cannot transfer into it. Paused preparation, zero preparation plays, retained
attachment/source, immediate sole-owner play, sound permission, freshness,
advancement, resource ceiling, return expiry and terminal Retry remain required.

The next physical check is a new source comparison on the same build and matched
conditions, with screen recording off for the initial trace/perception assessment.
Start each attempt in a fresh Safari tab, Play Carlos, grant sound, allow Noah to
qualify through paused preparation, then physically swipe once to Noah. Preserve
the original export before Retry/reset and report the brief catch, complete
opening words, continuity, sync and sharpness separately. Compare processed and
original Noah on that same build; reverse the order if a first pair suggests a
benefit. Retain misses, rejections and uncertainty. A source difference would
support further source assessment, not isolate a decoder cause or authorize a
normal-feed default, encoding rollout or LIVE release.
