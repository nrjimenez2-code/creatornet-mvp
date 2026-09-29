# Preview HLS controller comparison

This is an experimental branch based on preparation candidate `34c0788be78f26637ce48a9f45c542f7577d503d`. It is not a Production release candidate. Do not merge the lab into the normal feed.

## Entry points and scope

- `/playback-lab?feedDebug=1&mode=current` uses the unchanged candidate controller.
- `/playback-lab?feedDebug=1&mode=rate` uses the isolated rate prototype.
- The server returns 404 unless `VERCEL_ENV` is exactly `preview`. Other mode values also return 404.
- Both modes use exactly the three existing public HLS sources in `lib/feedAdaptiveManifest.json`. There is no arbitrary media URL input, catalog change, or new hosting resource.
- Native HLS support is required. The page does not substitute MP4 or HLS.js.
- The normal feed continues to import `lib/mobileFeedController.ts`. Only this Preview page imports the prototype.
- Normal root layout providers remain present. The lab itself does not mount feed cards, query the feed, or send engagement/payment events. This is not a completely isolated network sandbox.

## Experiment

The rate prototype removes repeated bridge alignment seeks. With fresh main and bridge frames, it can apply one fixed 0.75x or 1.25x rate to the muted bridge. Audible main stays at 1x. Actual frame alignment and a rate-weighted age projection must both meet the original frame tolerance. The existing three-second watchdog remains unchanged; unsupported, ignored, late, or unsuccessful corrections retain bounded recovery.

Synthetic tests demonstrate ideal convergence and bounded cleanup. They also deliberately demonstrate a failing visual case: an injected 300 ms rate-change freeze causes a 352 ms frame gap. Native Safari support, rate-change freezes, temporary speed changes, sound synchronization, picture quality, and warm startup performance are unverified. This experiment alone does not improve time to the first moving bridge frame.

## Phone comparison

1. Open the exact deployment's `mode=current` link in Safari. Keep Low Power Mode off and use the same network for both modes.
2. Press Play, then Tap for sound. Watch each clip for at least five seconds, physically swipe to the next, and repeat through all three clips. Do a second pass back through them.
3. Use physical swipes for measurements. Next/Previous are only functional controls: a button click may renew a browser gesture grant.
4. Open Capture controls after the run, label the conditions and run ID, and export without resetting. Build identity and controller mode are seeded automatically; `labBuildCommit` and `labController` preserve them in the export.
5. If Retry appears, export before tapping Retry so the initial failure remains available. Do not start a new diagnostic run after a failure.
6. Repeat with `mode=rate` on the same deployment and note startup delay, any visible freeze or speed change, sound synchronization, and settled sharpness. Export the second JSON separately.

These are diagnostic controller comparisons. They do not complete Discover/Following, Safari/Instagram, long-session, sound, resume, or matched TikTok acceptance.

## Local tests

The rate-aware clock tests cover ideal convergence, nonconverging engines, stale evidence, the missed alignment window, waiting, cancellation, rate cleanup, and the injected visual failure. Page tests cover deployment guard, fixed sources, terminal errors, Retry, neighbor visibility, and pause/swipe behavior. Browser and physical-device checks remain separate evidence.
