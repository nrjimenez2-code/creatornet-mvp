# Preview comparison of existing playback formats

The full mobile playback goal still requires matched Carlos/Noah original,
processed MP4 and direct-ready native HLS phone trials. The legacy three-HLS
controller experiment did not perform that comparison. This separate route
holds the preferred diagnostic `steady` controller constant while changing only
the selected existing source family. Steady is not an accepted feed candidate:
prior quadrant freezing remains intermittent, warmed starts exceed 150 ms and
the observed bridge handoffs use unaligned watchdog recovery.

## Scope and identity

- `/playback-formats?format=original&feedDebug=1`: Carlos and Noah originals.
- `/playback-formats?format=mp4&feedDebug=1`: their existing processed MP4s.
- `/playback-formats?format=hls&feedDebug=1`: their existing direct Stream masters.
- Exactly `VERCEL_ENV=preview` is required. Other environments return 404.
- Only the three closed format values are accepted. No arbitrary source URL or
  controller input can change the fixed comparison. Native HLS is required for
  HLS; MP4 checks native MP4 support and never substitutes for unavailable HLS.
- These are the two audited auto-upload source families, not the three legacy
  entries in `feedAdaptiveManifest.json`. Both public descriptors were read on
  September 30 and matched the September 27 source/version/association receipts.
- The fixture URLs are fixed in `lib/playbackFormatFixtures.ts`. Selection does
  not generate downloads, encode media, write processing records, change the
  catalog, proxy/cache manifests or provision infrastructure.
- Each format has separate post IDs and content versions. Changing format
  cannot carry a position across sources without timeline proof. No fallback or
  new timeline proof is enabled. The shared audible player, return policy,
  preparation budget, controls and three-second watchdog are reused.
- `labFormat`, `labFixtureSet=carlos-noah-v1`, `labController=steady` and the exact
  build are recorded locally. Build `81d8859` exports the format, source kind and
  source-match checks but does not export an actual source URL. Its initial
  three phone runs remain diagnostic evidence with that limitation.
- With `feedDebug=1`, `lab-source-readback` records the actual `currentSrc` once
  per main/bridge role after it matches the activation's closed public fixture.
  An unrelated previous source is never exported. A master URL does not prove
  the native HLS variant; use rendition/network evidence for that separately.
- Preview startup diagnostics retain up to eight raw main frame callbacks per
  activation, including request, delivery, submission, target and qualification
  state. Up to four bridge play requests and their owned promise settlements
  distinguish a native playback wait from callback delivery. Missing processing
  duration is null. These local events do not change playback or handoff guards
  and do not measure physical pixels or sound.

The recorded `c555d95` direct switch still has a 0.267-second bridge lead. Both
play requests occur at 1 ms, while the bridge promise settles after 184 ms and
the main `loadstart` event is delivered at 189 ms. Existing samples do not
separate time spent inside the native `play()` call from the subsequent promise
wait or event delivery. They do not establish a native startup cause.

With `feedDebug=1`, the lab now samples at most four native play calls per role
and activation. `lab-main-play-returned` and `lab-bridge-play-returned` record
synchronous call duration. Their matching `*-play-settled` events record total
elapsed time and `afterReturnMs`, the interval from return to promise delivery.
Main timing is captured before the controller starts the bridge. Settlements
require the same active owner; bridge settlements also require the same slot
generation. No source URL is added to these events. Debug-off playback does
not attach these diagnostic settlement callbacks.

This is a missing timing boundary, not a new playback variant or a fix. The
native calls, their ordering, sound element, source assignment, bridge rates,
seeks, frame/target/alignment guards and watchdog remain the same. On a newly
approved exact-build Preview, retain one new direct processed-MP4 first switch
with sound and its export/paired recording. Reuse the completed `c555d95`
recording review as comparison; do not recapture it. A slow call return would
support investigating native synchronous work; a quick return followed by a
long settlement would support investigating asynchronous startup/scheduling.
Neither result alone identifies a native decoder or source-fetch cause.

The completed `fc1c402` phone run separates those boundaries: the main native
call measured 0 ms at timestamp resolution, followed by a 319 ms promise wait;
bridge native work measured 99 ms, followed by 41 ms. The main's first callback
reported media time/position zero, then its next callback arrived 527 ms later
while the bridge continued regular callbacks. The recording confirms about
0.66–0.69 seconds of picture lead, then a backward content step at the unaligned
watchdog. Preserve that completed trace/recording; another symptom-only capture
is unnecessary. Main native startup and media-clock progress remain unresolved.

With `feedDebug=1`, at most 32 existing accepted `bridge-frame` events per
activation now also contain `mainClock*` fields: main position, readiness,
network/buffer, pause/seek/mute/rate, source match, playing-event state and latest
main callback. These observe the main between its callbacks using the already
scheduled bridge callback. They add no timer, frame request or trace event.
Later bridge events omit these fields. Existing bounded main native-return,
settlement and startup-frame samples also read the available audio-session
state/type. Only documented enum values are recorded; unsupported, missing
state and thrown getters are explicitly unavailable.

These reads never set `navigator.audioSession.type`, request permission, attach
session listeners or change playback calls, source/seek/rate/grant behavior,
ownership, guards or budgets. Debug-off does not access the audio-session API.
The state is page-wide and may be unavailable or policy-filtered; it is not
acoustic onset, per-player state or proof of a native decoder/buffering cause.
The purpose is to distinguish late main callback delivery from slow main
media-clock progress, and retain any observable session admission/interruption.
Use paired recording plus a newly approved exact-build export for that new
question; do not treat local fixtures, an active session or a playing event as
sound/performance acceptance.

Primary-source review: [WebKit HTMLMediaElement](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLMediaElement.cpp)
already invokes its load/reset path when `src` changes. [AudioSession IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.idl)
and [implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp)
show state availability gates and page-level reads. Current upstream source is
context, not identification of the WebKit build installed on the phone.

## Processed-MP4 direct transfer control

The recorded `683310b` first swipe shows the muted presentation bridge ahead of
the shared player carrying sound. The trace's watchdog lead is 0.700 seconds;
the paired recording corroborates the initial mismatch and later convergence.
It does not establish why the native main player starts later.

`/playback-formats?format=mp4&transfer=direct&feedDebug=1` is a new, opt-in Preview
control. For an actual post-to-post switch, release still pauses the main,
revokes ownership, saves the fixed departure snapshot and cancels its seek
immediately. An immediate claim moves that same element straight to the next
card instead of first appending it to the hidden 1px parking container. If no
claim follows before the queued microtask, it parks normally. Stale parking
callbacks cannot move a newer owner or supersede a later release.

This changes one DOM transfer step. A benefit on iPhone is a hypothesis, not a
verified cause or fix. It keeps the same steady bridge, source pair, sound
element, native play calls, frame/target/alignment guards, rates, seeks and
three-second watchdog. Retry and unmount use immediate parking. Default format
routes and the normal feed retain their existing parking path. `transfer=parked`
selects that baseline explicitly; other transfer values or direct transfer with
original/HLS return 404.

The footer identifies the direct comparison. The automatic `labMainTransfer`
field records `direct` or `parked`; `main-transfer` proves an actual direct move
or the no-immediate-claim fallback. Use the retained `683310b` recording as the
baseline. After a new exact-build Preview is verified, capture one matched
first Carlos-to-Noah physical swipe with sound and a short paired recording.
Keep the JSON, failed outcomes and observations. Improvement must include sound
and picture together, without slowing the already-smooth picture. Do not repeat
the old baseline merely to confirm its already-measured symptom. This control
does not satisfy normal-feed acceptance or authorize a Production release.

## Initial phone comparison

Use the same iPhone Safari, network, orientation, power and starting thermal
conditions for all three runs. Use a fresh page for each format, verify its
format/build label and enter known capture conditions. Do not reset a cold
entry. Record picture and sound together; retain every failure before Retry.

1. Tap Play, then Tap for sound once. Watch Carlos for at least five seconds
   after motion starts, keeping that saved departure position.
2. Swipe to Noah. After about two seconds of motion, return immediately to
   Carlos. Verify the intended saved position and sound. The trace determines
   actual absence: a slow start can cross five seconds, in which case restart
   is correct rather than a failed short return.
3. Watch Carlos for at least five seconds, then swipe to Noah again. Watch Noah
   for fifteen seconds after motion starts, including all picture quadrants.
4. Return to Carlos. This absence is longer than five seconds and should restart
   at zero. Watch for five seconds and check opening flashes, sound and detail.
5. Export trace without resetting. Use a run ID containing the build and format.
   Attach the paired recording if made. Report startup, jumps/flashes, quadrant
   freezes/clearing, sound continuity/sync and settled sharpness for both clips.
6. Repeat the same Carlos -> Noah -> Carlos -> Noah -> Carlos sequence for the
   other two formats. Keep cold starts, misses, returns and failed outcomes.

This initial comparison is diagnostic and does not replace repeatability,
physical recording/profiling or normal-feed acceptance. Choose a format only
after its picture, sound and continuity gates pass. Resource snapshots do not
measure native decoder lifetime or phone process memory. Reuse the completed
byte/codec/timeline/SSIM/audio audit and 72 local decode/seek trials; do not repeat
or rebuild those assets to fill the missing device evidence.

The original Safari/Instagram x Discover/Following warmed matrix (100 attempts
per cell across three runs), 150 ms p95, no unexplained freeze over 250 ms or any flash, 300-transition
resource session, function/return/sound/quality matrix, matched TikTok comparison,
minimal normal-feed integration and separate PR242 Production approval remain
open. A passing local/CI/Preview format page is not those acceptance results.
