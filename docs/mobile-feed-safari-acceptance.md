# Mobile feed Safari acceptance

This candidate changes only the main phone feed. Desktop feed cards and opened
post viewers keep their existing player path. The candidate reuses one active
media element, limits muted next-card preparation until the active card has
shown a frame, and restores a recent feed and scroll position after an in-app
profile visit. A fresh feed request then revalidates the restored rows.

## iPhone check before release

Open the **draft preview** in iPhone Safari with `?feedDebug=1` appended to its
dashboard URL. The small overlay is only shown with that query parameter. It
shows the active post, HLS/MP4 source, first-frame time, stall count, live
buffer ahead, and dropped frames. Record the iPhone model, iOS version, and
whether the run used Wi-Fi or cellular.

1. Fresh open: if Safari offers **Tap for sound**, tap it once. Confirm video
   continues and sound starts.
2. Swipe 1 → 2 → 3 at a normal pace, then 3 → 2 → 1. Repeat with quick swipes.
   Record any repeated sound prompt, blank frame, delayed start, or visible
   pause. Capture the overlay on each card, especially the third.
3. From the third card, open Profile and return using the app navigation.
   Confirm the same card and scroll position appear promptly and sound remains
   on without a second tap. Repeat after deliberately muting; mute must remain
   the chosen setting.
4. Reload the page once. Safari may require a new sound gesture after a full
   reload; record whether it does. The no-repeat target applies to consecutive
   cards and an in-app profile return.
5. Check the desktop preview once for unchanged playback, seeking, and mute.

The release target is no repeated sound prompt after the first successful tap
during one in-app session, no blank card during handoff, and no visible stall on
the normal swipe or profile-return run. Compare first-frame time and stall count
with the live site on the same iPhone and network. If a run fails, retain a
screen recording and the overlay values. Safari Web Inspector's Network panel
can identify the selected HLS variant; the video element itself does not expose
that choice reliably.

## Current media coverage

The current third feed video has a reachable Cloudflare Stream HLS master
playlist with 720×1280, 480×852, 360×640, and 240×426 variants at 30 fps;
its variant playlists use four-second segments. This verifies published
renditions, not which one Safari selects or how quickly a segment arrives.
The live first video is a newer `/auto/videos/` upload and currently takes an
optimized MP4 path. The static adaptive manifest covers only explicitly listed
older renditions, so new uploads do not automatically select HLS in the feed.
Check a new upload's source type and startup/stalls on the iPhone before
changing that media pipeline.

Do not treat unit tests, desktop emulation, or a successful preview build as
iPhone Safari acceptance. Record the device results before merging or
promoting this candidate.
