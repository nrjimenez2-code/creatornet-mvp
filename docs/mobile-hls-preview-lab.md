# Preview HLS controller comparison

This is an experimental branch based on preparation candidate `34c0788be78f26637ce48a9f45c542f7577d503d`. It is not a Production release candidate. Do not merge the lab into the normal feed.

## Entry points and scope

- `/playback-lab?feedDebug=1&mode=current` uses the unchanged candidate controller.
- `/playback-lab?feedDebug=1&mode=rate` uses the isolated rate prototype.
- `/playback-lab?feedDebug=1&mode=prearmed` tests a second isolated rate variant. It assigns 0.75x to a hidden, paused opening bridge when preparation becomes ready, before activation; it does not write a correction while that bridge is moving. This tests the Safari post-write callback gap seen in the first phone comparison.
- `/playback-lab?feedDebug=1&mode=steady` disables rate correction and alignment seeks. Both videos retain 1x; naturally aligned frames may hand off, otherwise the same three-second watchdog controls recovery. This is an isolated test of removing the rate writes that repeatedly preceded long callback gaps.
- The server returns 404 unless `VERCEL_ENV` is exactly `preview`. Other mode values also return 404.
- All modes use exactly the three existing public HLS sources in `lib/feedAdaptiveManifest.json`. There is no arbitrary media URL input, catalog change, or new hosting resource.
- Native HLS support is required. The page does not substitute MP4 or HLS.js.
- The normal feed continues to import `lib/mobileFeedController.ts`. Only this Preview page imports the prototype.
- Normal root layout providers remain present. The lab itself does not mount feed cards, query the feed, or send engagement/payment events. This is not a completely isolated network sandbox.

## Experiment

The rate prototype removes repeated bridge alignment seeks. With fresh main and bridge frames, it can apply one fixed 0.75x or 1.25x rate to the muted bridge. Audible main stays at 1x. Actual frame alignment and a rate-weighted age projection must both meet the original frame tolerance. The existing three-second watchdog remains unchanged; unsupported, ignored, late, or unsuccessful corrections retain bounded recovery.

Synthetic tests demonstrate ideal convergence and bounded cleanup. They also deliberately demonstrate a failing visual case: an injected 300 ms rate-change freeze causes a 352 ms frame gap. The first physical Safari comparison found that both modes felt choppy; two applied reactive rate writes were each followed by about 525 ms without an advancing bridge callback, and only one of four warm rate handoffs finished before the watchdog. The callback gap is observed, but its cause and visible pixel duration are unverified. Sound synchronization and settled picture quality remain unmeasured. This experiment alone does not improve time to the first moving bridge frame.

## Phone comparison

1. Open the exact deployment's `mode=rate` link in Safari. Keep Low Power Mode off and use the same network for both modes.
2. Press Play, then Tap for sound. Watch each clip for at least five seconds, physically swipe to the next, and repeat through all three clips. Do a second pass back through them.
3. Use physical swipes for measurements. Next/Previous are only functional controls: a button click may renew a browser gesture grant.
4. Open Capture controls after the run, label the conditions and run ID, and export without resetting. Build identity and controller mode are seeded automatically; `labBuildCommit` and `labController` preserve them in the export.
5. If Retry appears, export before tapping Retry so the initial failure remains available. Do not start a new diagnostic run after a failure.
6. Repeat with `mode=steady` on the same deployment and note startup delay, any visible freeze or speed change, sound synchronization, and settled sharpness. Export the second JSON separately.

The `current` and `rate` comparison above was completed on build `a1b30dd902decba8fedd941406ffcfd89f2a75d3`. A second exact-build Safari comparison on `ebfba8ad9c7457bccdfdf3278c30cda3e481f23a` found `rate` visibly smoother than `prearmed`. The owner reported that only about one quarter of the prearmed picture moved while the other three quadrants appeared frozen. Prearmed had 546 ms and 763 ms bridge callback gaps after first motion, and all three warm activations reached the watchdog. Treat prearmed as a failed visual experiment, even though one partial preparation handed off early. The JSON contains timestamps and counters, not pixels, so it cannot identify the affected quadrants or their exact visual cause.

The second rate run also retained two 525 ms bridge callback gaps following its two applied rate corrections; all four later handoffs used the watchdog. Its two transitions without rate correction had no bridge callback interval above 250 ms. That small sample motivates `steady`, but does not establish its Safari result or sound synchronization. Rate remains the preferred comparison, not accepted normal-feed code.

The next comparison is `rate` versus `steady` on one exact Preview build, using the same physical swipe procedure and exporting both before Retry. The prototype now records bridge rate, submitted-frame counter, frame dimensions, compositor timing and decoding time when available. It also records rate resets caused by main waiting, pause, seeking or loss of playback. These observations can distinguish some callback-delivery and submission patterns; they still do not prove the pixels or audible output were correct. `steady` has no hosted or physical result until separately published and tested.

These are diagnostic controller comparisons. They do not complete Discover/Following, Safari/Instagram, long-session, sound, resume, or matched TikTok acceptance.

## Local tests

The rate-aware clock tests cover ideal convergence, nonconverging engines, stale evidence, the missed alignment window, waiting, cancellation, rate cleanup, and the injected visual failure. Page tests cover deployment guard, fixed sources, terminal errors, Retry, neighbor visibility, and pause/swipe behavior. Browser and physical-device checks remain separate evidence.
