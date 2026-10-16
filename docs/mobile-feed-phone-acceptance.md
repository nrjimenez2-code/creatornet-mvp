# Mobile feed phone acceptance

Status as of October 15, 2026: remaining manual iPhone Safari/Instagram acceptance, warmed-transition cohorts, physical performance measurements, resource profiling and TikTok comparisons are **owner-waived and unverified, not passed**. Do not start another manual testing cycle for this release. Historical traces and failures remain preserved. The reference device is the owner's iPhone 17 Pro Max; intended mobile surfaces remain Safari and Instagram's link browser, Discover and Following. The protocol below remains a historical acceptance specification, not completed evidence or an instruction to resume testing.

## Builds and controls

The reviewed release enables prepared playback by default on supported mobile Discover and Following pages, including Safari and Instagram, without a query selector. Browsers without video-frame callbacks retain conventional playback. `feedTransfer=0` selects conventional playback for the page session. The prior bridge comparison remains available with `feedBridge=1`; it is a separate path and its cohorts must not be pooled with prepared-player transitions. Desktop ignores both mobile selectors. An explicit transfer selector takes precedence over the legacy bridge selector. Diagnostics remain opt-in with `feedDebug=1`; `feedReadout=0` disables live polling while preserving capture/export controls.

The prepared-player path shares the lab's paused preparation and ownership implementation. It loads at most one neighbor after qualified main motion, never plays preparation, and adopts only the same connected element/source/content version/snapshot/target with a valid target frame and sufficient actual buffer. The old source is removed before selected main play; deferred retirement and rate controls remain lab-only. Each main play attempt must resolve and fresh advancing submissions (at most 100 ms old) must qualify before startup success. Policy-denied sound uses the feed's muted fallback and explicit sound gesture; unresolved or rejected playback is not evidence of a transferable sound grant. Terminal playback/media/seek failures stay behind explicit Retry. No physical latency improvement is established by this integration.

Controller and readout selections persist during in-app navigation for that page session. `feedReadout=0` keeps local capture/export controls while disabling live media polling; `feedReadout=1` restores the readout. Record this choice in comparisons. The diagnostics-only historical checkpoint is `aa9b2d0`; it is not the revision of the new candidate.

Prepared-feed resume identity also includes the selected delivery URL. A shared asset version alone does not prove matching timestamps between HLS, processed MP4 and original media. Changing the selected URL invalidates the saved position; nonzero error fallback still requires the existing verified timeline-mapping gate. Keep delivery choices explicit when testing profile return.

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

The owner authorized the complete reviewed feed release, including default enablement, conditional on focused code/release review and required automated gates passing with no unresolved code, security, data-integrity or deployment blocker. The manual gates above are waived, not passed. This release changes no provider, schema, ranking or media asset. See `mobile-feed-controlled-release.md` for the current scope and rollback. Exact deployed revision, served routes/bundles and default behavior still require LIVE verification.

To disable prepared playback for a page session, use `feedTransfer=0`; `feedBridge=0` also disables the mobile controller when no transfer selector overrides it. To roll back deployed code, use the existing release workflow and verify the canonical deployment commit while preserving unrelated newer work. Preserve historical traces and recordings.
