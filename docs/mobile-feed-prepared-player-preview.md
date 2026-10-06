# Prepared player Preview experiment

Status: local prototype, physical sound/grant/continuity/performance acceptance pending.
The normal feed and existing format comparisons keep their defaults.

The Preview-only route `/playback-formats?format=mp4&transfer=prepared&feedDebug=1`
opts into the existing closed Carlos/Noah processed-MP4 pair. Other formats cannot
use this selector, and the route returns not-found outside `VERCEL_ENV=preview`.
Its footer and exported context identify `prepared` plus the exact build commit.
Use an immutable deployment only after exact-head publication approval and full CI.

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
element plus at most one muted preparation
slot is retained. Neighbor decoding waits for qualified active motion. Disposal and
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
