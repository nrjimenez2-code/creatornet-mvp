# Mobile preparation, resume and playback resolution candidate

This candidate starts from verified main `332bafd3da0daee65ffd6e727262d7884a5b7684`. Preserve PR 233 and its diagnostics-only branch for comparison. No phone performance or quality acceptance is established by automated tests or a Ready Preview.

## Behavior and boundaries

`feedBridge=1` opts the mobile feed into corrective target-frame acquisition, two bounded preparation attempts, partial preparation retention, and three-second handoff recovery. The same audible element is retained. One additional preparation decoder is permitted only after the main video emits `playing` and has one second of playable media (or its remaining duration). Loading the selected neighbor can start earlier. Direction changes, feed changes, hiding, expiry and disposal cancel obsolete preparation. Incomplete preparation never qualifies the activation as warmed.

The player owns one immutable departure snapshot per recent post, including exact content version, position and expiry. Candidate returns before 5,000 ms resume; returns at or after 5,000 ms restart. Reads and retries never refresh the departure deadline. Returning consumes history. A new departure creates a new window. One shared timer expires at most two saved positions, releases matching offscreen preparation and clears an expired parked source without replacing the audible element. Other entries cannot rewind an active owner. Ordinary controller-off playback retains its existing boundary and parked-source behavior during validation.

At three seconds, a valid, recently moving main player releases a misaligned bridge. Otherwise the bridge and incomplete preparation are released, the main pauses and the existing error/Retry presentation appears. Retry is a user action; source replacement and preparation do not override manual pause or sound preference.

`GET /auto/playback/videos/<public-video-key>` is a read-only Worker endpoint. It checks the current source ETag every time, derives the content version from the source key and ETag, verifies the processed object's immutable job key/existence/type, and reads matching existing jobs to recover ready public HLS URLs and duration. It does not import, generate downloads, persist missing duration or write processing records. Metadata caching is bounded, isolated by binding, expires after 30 seconds without sliding expiry, and never bypasses source or MP4 checks. Errors still use `no-store` and credential-free public CORS.

Only the active card and predicted neighbor resolve. Requests deduplicate and cancel when obsolete. An unresolved lookup falls back within one second. A selected source stays pinned for that activation; a late result cannot swap a playing source. Neighbor activation transfers the same resolved descriptor. No duration/source association is promoted to timeline proof. Nonzero fallback remains terminal Retry unless an exact-version proof exists; attempts cannot loop.

## Independent controls and comparison

| Query controls | Purpose |
|---|---|
| `feedBridge=1&feedDelivery=mp4&feedDebug=1` | Candidate controller and verified versioned MP4 delivery |
| `feedBridge=1&feedDelivery=0&feedDebug=1` | Candidate controller with existing delivery route |
| `feedBridge=0&feedDelivery=mp4&feedDebug=1` | Resolved MP4 delivery with conventional presentation |
| `feedBridge=0&feedDelivery=0` | Ordinary mobile presentation and delivery |
| `feedBridge=1&feedDelivery=original&feedDebug=1` | Explicit original-file comparison |
| `feedBridge=1&feedDelivery=hls&feedDebug=1` | Explicit HLS comparison on native-HLS browsers only |

Desktop ignores these mobile delivery/controller controls. HLS is a trial, not an accepted default. The default candidate keeps MP4. Manifests are loaded directly from Stream; neither the Worker nor client caches/proxies their bodies, as required by [Cloudflare guidance](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/). The [Stream binding](https://developers.cloudflare.com/stream/manage-video-library/bindings/) exposes `hlsPlaybackUrl`; the resolver also accepts the HTTP response shape when present.

Compare existing resources first:

| Clip | Original public key | Existing immutable MP4 job | Existing Stream UID |
|---|---|---|---|
| Carlos, Ecom is not for the Weak | `videos/7cb02077-bcba-4c29-8f3c-f1584d1ed961/1790458342012.mp4` | `1eb772bf1adb09390a6b6993ed85b44f68247d91a45b550523f900f55736af4a` | `055c52cd11ab6482f3c4fdbc9336fb10` |
| Noah, demo | `videos/767658b6-7b2a-4cc4-91b4-6a0f78073a8e/1789953087942.mp4` | `d2c530f03d2bde9217da9f830ff964141be5843a7ba5afee9332fb708bdf49ee` | `50eed272e3d4283f18f4b67a03e04ae7` |

Verify these identities live before comparison. Do not re-import or regenerate them. Test settled detail, sound, startup, resume/seek alignment, continuity and warmed presentation on the same phone and conditions. Enable HLS beyond explicit trials only after all gates pass. If both formats pass, choose lower warmed presentation p95, breaking a tie with cold startup. Missing presentations and failed transitions stay in the denominator.

If measured seek/decode or quality failures remain after this comparison, prepare a separate bounded encoding trial for these two clips: retain source dimensions/frame rate, H.264 with compatible pixel format, fast-start MP4, keyframe gaps at most two seconds, and copy compatible audio. Compare detail, bytes, startup, random access and A/V alignment against original and existing MP4/HLS. New immutable keys may be published only after review and measured improvement without settled-quality loss. No catalog backfill is included.

## Validation and release gates

Follow `mobile-feed-phone-acceptance.md`. First reproduce Safari/Wi-Fi/Carlos cold entry, next clips, immediate return, exactly-five-second boundary and later return with picture and sound recorded alongside trace exports. Then collect Safari/Instagram × Discover/Following: 100 warmed transitions across at least three runs for every combination, p95 ≤150 ms, no unexplained freeze >250 ms, no blank/wrong-post/opening-frame flash, no repeated sound tap or A/V regression, and preserved settled sharpness. Include a 300-transition resource/performance session and matched TikTok comparison on the same phone. Report cold starts, preparation misses and failures separately. No metric can substitute for recordings, sound or physical-device resource evidence.

New local diagnostics cover resume departure/decision/expiry, content version, loading/acquisition/retry/cancellation, corrective seek, partial recovery, handoff recovery and resolution selection. Existing viewport, RAF, long-task and media-resource capture remains available. Profile viewport/React/telemetry/decoder overlap only if device scrolling still fails; do not change ranking, payments, the database or broad analytics based on a hypothesis.

The existing Worker has public `workers.dev` and version previews disabled. A Vercel Preview alone cannot prove this new resolver is hosted: until an approved Worker deployment, the public endpoint remains unavailable and the client safely uses ordinary delivery. Enabling a Worker version preview or deploying the reviewed resolver requires scoped approval. Record the exact app commit, Worker version and deployed endpoint before calling the full path live.

## Release and rollback

Review the exact PR, passing hosted CI, immutable Preview, Worker package and limitations. Release through the opt-in path only after scoped approval. Verify the canonical app commit and active Worker version. Expand ordinary mobile playback only after the complete phone matrix passes.

For session rollback, independently set `feedBridge=0` and/or `feedDelivery=0` on a fresh page; preserve traces first. Controller-off does not revert shared source/seek guards from previous releases. For code rollback, restore the reviewed application/Worker version independently while preserving intervening unrelated work. The verified starting app deployment is `dpl_5q5wg5MtJMmKxysj1252ZGdV71Ds`, commit `332bafd3da0daee65ffd6e727262d7884a5b7684`. The current Worker version at preparation is `36e291c6-2ce0-479d-9af1-a03efd6dfd10`; recheck active deployment before using it as a rollback target.
