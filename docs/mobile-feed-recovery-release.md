# Mobile feed playback recovery

The normal mobile Discover and Following feeds retain the full feed upgrade and
the default `prepared-preload-audio` selection. Audible playback now keeps one
video element across cards so a granted sound permission stays with that element.
One qualified neighbor may supply a paused, muted cover while the main element
starts. The cover does not prove audible output or moving-main readiness. It is
cleared on handoff, recovery, failure or release; no third sourced player is admitted.
Desktop and explicit lab promotion modes keep their existing selection behavior.

## Audit findings and corrections

| Finding | Correction | Automated coverage |
| --- | --- | --- |
| 1. Repeated sound taps after player replacement | Retain the audible element and saved preference; keep prepared covers muted | Prepared cards: per-element grant across A/B/A; controller ownership/cover checks |
| 2. Transient play rejection becomes terminal | One guarded retry for current AbortError; then a bounded terminal state | Card recovery and controller recovery tests |
| 3. Stale Retry overlay after successful return | Clear media error when the new activation qualifies | Card recovery same-source return test |
| 4. Late resolution changes an active source | Pin descriptor or fallback selection through activation and visibility changes | Playback resolution hook tests |
| 5. Backup selects the same failed MP4 | Choose fallback from the actual selected format; preserve timeline safeguards | Card recovery MP4/HLS mapping test |
| 6. Retry reload persists | Consume reload once per explicit Retry | Card recovery prepared-return test |
| 7. Post-start stalls have no bounded recovery | Sample advancing frames after startup; recover once, then expose Retry | Controller post-start stall cases |
| 8. Unexpected startup pause strands playback | Recover a current unsolicited pause while respecting manual, navigation, hidden, modal and audio-session pauses | Controller interruption and pause cases |
| 9. Seek consumes startup budget | Start the three-second frame budget after the independently bounded two-second seek | Controller slow-return test; player seek safeguards |
| 10. Late callbacks rejected despite progress | Require advancing source/epoch/frame identity rather than a 100 ms delivery-age cutoff | Controller delayed-callback and replay rejection cases |
| 11. Missing or misleading diagnostic causes | Record bounded resolver/play/seek reasons and actual source kind; whitelist error names | Resolver and controller diagnostic tests; fallback label assertion |

Recovery remains limited to one automatic attempt per activation. Policy refusal
can fall back to muted playback without changing the saved sound choice. Explicit
manual pause, route navigation, hidden pages, Insights suspension and interrupted
audio sessions must not consume that recovery attempt or restart audio. Stale
owners, stale frames and unverified cross-format resume positions remain rejected.

## Evidence limits and owner waiver

The owner waived the remaining manual iPhone Safari/Instagram acceptance runs,
warmed-transition cohorts, physical performance and sound measurements, resource
profiling, and TikTok comparisons. These remain **owner-waived and unverified**.
Automated media-event tests and browser checks establish their stated mechanisms,
not physical Safari output, smoothness, thermal behavior or decoder reclamation.

The owner's observed slowdown occurred before any Retry click. The persistent
Retry flag is a separate defect, and the older HLS mapping defect does not match
Carlos's audited source. The exact native event sequence of that incident remains
unknown. No memory leak, corrupt Carlos file, network fault or overheating cause
was established. This release introduces no migration, financial/provider action,
credential change, or change to media timeline-equivalence safeguards.
