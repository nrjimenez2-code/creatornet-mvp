# Mobile feed phone acceptance

Status: candidate, not accepted for release. The reference device is the owner's iPhone 17 Pro Max. Required surfaces are Safari and Instagram's link browser, for Discover and Following.

## Builds and controls

The diagnostics-only checkpoint is `aa9b2d0`. The candidate uses `?feedDebug=1&feedBridge=1`; `feedBridge=0` selects conventional playback. Candidate mode is retained during in-app navigation for this page session. Opening a fresh page without the parameter defaults to conventional playback. Desktop ignores the candidate switch.

Use an immutable preview for each build and record its exact commit. Do not call the current candidate with its switch off an untouched production baseline: shared lifecycle instrumentation can evolve during implementation. Use the separate diagnostics-only baseline branch for the before measurement.

Open Capture controls, fill runId, buildCommit, surface (`safari` or `instagram`), iOS version, Instagram version, network (`wifi`, `cellular`, or `constrained`), power mode, temperature condition, and recordingId. The feed and candidate mode are recorded automatically. For a warmed run, set conditions, start a new run, hide capture controls, and swipe to the first scored post. The already-active post at reset is outside the scored run. For cold entry, record from the initial page opening and fill conditions before export without resetting. Export at the end. Export uses native file sharing where supported, otherwise download. A cancelled share leaves the trace in memory for another attempt.

Trace history is local to the tab, capped at 24,000 events and reports dropped events. Export before reloading/closing the tab. A truncated capture cannot pass. Do not infer zero transfers from unavailable cross-origin Resource Timing values.

## Matching conditions

Use the same phone, iOS, network location, brightness, power mode and initial temperature for baseline, candidate and TikTok. Record Instagram and TikTok versions. Avoid charging for one run and battery operation for another. Note battery percentage and warm/hot state. Let the phone return to the same starting condition between comparisons. Record whether an external camera or screen recording was used; screen recording itself can affect cadence.

Record video and sound together. An external high-frame-rate recording that captures the finger and phone display is the reference for gesture-to-visible-output and audible onset; an iPhone screen recording is supporting evidence. The trace's requestAnimationFrame cadence is observed main-thread scheduling, not proof of physical 120 Hz presentation. requestVideoFrameCallback is a compositor submission, not proof of the pixels the user saw.

## Main sample

For **each build**, each surface and each feed tab, collect at least **100 eligible warmed transitions across at least three runs**, for example 34 + 33 + 33. Do not stop at 100 successful transitions while dropping failures. Keep every attempted activation in the export. Record preparation misses and cold activations separately. Do not relabel a transition as warmed after seeing a fast result.

Warm eligibility is decided at activation: the same prepared element/source, correct recent-return target, a valid target frame, and at least one second of actual buffer (or the remaining duration near the end). A preload hint or timeout is not readiness. Baseline traces predating measured warm eligibility must not be pooled into this cohort.

Use the same sequence of posts where feasible, including the audited long-keyframe-gap auto upload. Dwell long enough for preparation during ordinary warmed swipes, then run rapid/reverse scenarios separately. TikTok gets matching gesture sequences, dwell times and session length; it does not get an invented instrumented p95.

## Scenario record

Record every failure with run ID, approximate recording timestamp, post ID, scenario and symptom.

| Scenario | Evidence to record |
|---|---|
| Cold entry | Navigation and activation timing, first picture, first audible sound |
| Ordinary warmed swipe | Moving presentation latency, audible-player latency, visible/audio result |
| Rapid multiple swipes and skipped cards | Wrong-post flashes, obsolete playback, preparation cancellation |
| Immediate reversal | Prepared direction and recent-return position |
| Return within/after 5 seconds | Resume within the 5-second/two-position policy; restart after expiry |
| Return near clip end | Correct end position and clean loop without opening-frame flash |
| In-app profile and back | Same sound grant, expected feed/scroll/position |
| Discover/Following switch | Old preparation cancelled; ordering and pagination intact |
| Pause, mute/unmute, scrub | Manual pause survives preparation/fallback; timeline remains correct |
| Background/foreground | Decoder stops while hidden, sound preference and position remain coherent |
| Failed media / missing poster | Terminal error and Retry work; no wrong-post cover |
| HLS to MP4 fallback | Error and position captured; only verified timeline mappings restore position |
| Overwritten source | A different content version must not inherit an old timeline proof |
| Wi-Fi / cellular / constrained | Keep separate cohorts; include all network failures |
| 300-transition session | Element/listener counts and device memory/thermal trends at start, 100, 200, 300 |

Controlled fallback and overwritten-content fixtures must use test assets and route interception or a local harness. Do not overwrite production content to exercise them. Current recovery deliberately holds at the error/retry UI when a nonzero position has no verified rendition timeline. The source-to-Stream association is not sufficient timeline proof.

## Required gates

- Warmed activation to valid moving presentation: p95 <=150 ms, with all missing outcomes retained as failures.
- No blank, wrong-post or opening-frame flash during recent resume.
- No unexplained freeze over 250 ms during normal warmed swipes.
- No repeated sound tap after the initial grant during swipes or in-app profile return.
- No delayed sound or visible A/V regression hidden behind the muted bridge.
- No visible scrolling regression against TikTok under matching phone conditions.
- Preserve settled sharpness and reject distracting quality jumps.
- No growing element/listener leak or worsening transition distribution during the long session.

The extra decoder is an experiment: compare CPU, memory, battery/thermal behavior, transferred bytes, stalls, sound and scrolling before retaining the bridge. Browser APIs cannot supply iPhone process memory, decoder cost or acoustic onset; mark these unavailable until device recordings/profiling fill them. Compare diagnostic-on and diagnostic-off runs to assess instrumentation overhead.

## Analyze exported traces

From the checkout:

```powershell
node scripts/analyze-mobile-feed.cjs run-1.json run-2.json run-3.json > report.json
```

The report separates browser, feed, network, build and conditions; reports missing warmed outcomes, cold activations, preparation misses and all recorded failures; and ranks activation-to-event delays. It always leaves overall acceptance unestablished because recordings, sound, resource review and TikTok comparison require human/device evidence.

## Release and rollback

The candidate is off by default and has no deployment/provider/schema/ranking/media-asset change. Completing this test plan and reviewing the exact diff must precede scoped Production approval. Any later release must identify the deployed commit and verify both surfaces against it.

To stop the experiment, open a fresh page with `feedBridge=0`. To roll back deployed code after an approved release, redeploy the last approved commit using the existing release workflow and verify the deployment commit. Do not roll back unrelated newer application work blindly. Preserve traces and recordings before switching builds.
