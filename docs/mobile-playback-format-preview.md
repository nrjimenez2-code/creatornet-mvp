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
  build are recorded locally. Check actual exported source URLs and source
  kinds; a requested query value is not proof of the selected media.

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
