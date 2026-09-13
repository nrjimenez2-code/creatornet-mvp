# Discover conversion ranking — rollout record

Status: implementation under validation, disabled by default. This is not a production rollout or a claim that all 21 requirements are complete.

## Behavior implemented

| Requirements | Implementation |
| --- | --- |
| 1–3 | Shared eight-category taxonomy, archived migration of old values and colliding scores, explicit topics, text/offer matching, onboarding priors and decaying behavior. |
| 4–7 | Private event ledger; product/booking taps; regular and monthly checkout starts; buyer-only redirects for creator-distributed full/exact installment links; Stripe setup separated from signed provider scheduling; payment-ledger reconciliation; later mentorship attributed to a verified call within 90 days. Attendance is deliberately absent. |
| 8, 11–12 | Recent unique-actor evidence, confidence bounds, minimum evidence threshold, separate offer queues and an ordinal commercial hierarchy. Exact commercial weights have NOT been fitted. |
| 9–10 | Actual visible playback time, seek/stall exclusion, monotonic server watch bounds, retry/milestone deduplication, authenticated commercial writes and like-cycle protection. Processor-verified duration enables completion. |
| 13–18 | Relevant exploration, limited proven related-topic trials, topic cohorts, rotating retests, unseen-first ordering, creator spacing, dismissal and decaying quick-skip signals. These are pilot policies, not experimentally validated allocations. |
| 19–20 | Actor-owned two-hour ranking snapshots, uncapped v4 pagination, live moderation rechecks, correct legacy cap termination and bans in existing feed functions. Following remains newest-first. |
| 21 | Private funnel, revenue-by-currency and viewer/day variety views; SQL, ranking, routing, watch, scheduling and regression tests. |

## Remaining work before production

1. Exercise buyer-link redirects through the full authenticated installment flow. The implementation now issues opaque redirect links without changing the stored Stripe URL. Only the matching signed-in buyer opening a currently active, matching Stripe session records intent; creator previews and anonymous opens do not. Previously distributed raw Stripe URLs cannot retroactively report checkout starts, but captured ledger receipts still reconcile sales.
2. Connect each real scheduling account and event type, then exercise genuine create/cancel/reschedule callbacks in a non-production environment. Cal.com and Calendly adapters exist; arbitrary providers require their own authenticated adapter. Existing unsupported booking links continue working without scheduled-call credit.
3. Verify the new routes and all four migrations against a complete isolated copy of the installed schema and an authenticated browser flow. Local PostgreSQL tests use a focused fixture, not a production clone. Review existing payment-ledger triggers and permissions before applying.
4. Deploy the media processor update separately and verify metadata for real videos. Unprocessed/external/legacy manifest sources may still have unknown trusted duration; those get qualified-view tracking but no completion award.
5. Measure production latency and database work with representative traffic. Initial ranking now reads only this viewer's 90-day history and requests indexed database summaries in batches of 200 posts. A fixture verifies 1,800 topic/total summaries without RPC-row truncation, and another verifies 2,005 posts/follows across cursors. New session creation prunes up to 100 expired snapshots, cascading their watch receipts; conversion history is retained. These local checks do not substitute for load measurement on the deployment database.
6. Run a controlled pilot with a stable comparison group and delayed conversion measurement. The observed live inventory on 2026-09-13 UTC was only three eligible posts from two creators. It cannot establish reliable commercial weights, sample thresholds or distribution guarantees.

## Configuration

Apply the four CLI-generated migrations in filename order before serving the new taxonomy/application combination. They were applied to CreatorNet Staging after the user-authorized local backup; production remains unchanged. Back up the installed schema/data first and compare taxonomy row counts, alias merges and original-value archives after migration.

Keep `DISCOVER_V4_ENABLED` unset or `false` until integration acceptance. It gates v4 ranking/client telemetry and booking adapters, but migration-installed ledger/like triggers collect facts independently. Reverting the application flag does not undo the taxonomy migration or delete its archive.

`DISCOVER_SCHEDULING_CONNECTIONS` is a server-only JSON array. Each entry binds one webhook URL to a provider, creator, event type and secret:

```json
[{"id":"creator-event-alias","provider":"calcom","creatorId":"CREATOR_UUID","eventType":"EVENT_TYPE_ID","secret":"SET_IN_SECRET_MANAGER"}]
```

Webhook URL: `/api/scheduling/creator-event-alias`. Supported provider keys are `calcom` and `calendly`. Calendly `eventType` is the full event-type URI; Cal.com uses the string form of the event type ID. Never expose this configuration in `NEXT_PUBLIC_*` variables or commit real secrets.

The completed Stripe setup creates an opaque source ID. Calendly receives it as `utm_content=cn_ID`; Cal.com receives `metadata[cn_attribution]=ID`. The internal `/api/book` router preserves it through creator booking-target selection. A webhook must match the configured creator/event, the opaque source and the viewer account email. A different attendee email remains unattributed. Calendar meeting-start/end timers do not prove attendance.

On sign-in, a verified signed browser identity is claimed by the authenticated account once. Its exposures and sessions transfer to that viewer, and existing sales are reconciled against the original exposure cohort. A second account cannot take that history. After sign-out, a claimed browser token rotates before new anonymous activity is accepted. Both the HTTP signature boundary and the SQL ownership/idempotency rules have tests.

Cal.com URL metadata parsing was checked in the provider's [BookerWebWrapper source](https://github.com/calcom/cal.diy/blob/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f/apps/web/modules/bookings/components/BookerWebWrapper.tsx). Provider payload/signature references: [Cal.com webhooks](https://cal.com/docs/developing/guides/automation/webhooks), [Calendly signatures](https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures). A live callback remains necessary to verify the account's payload version and configuration.

The media worker exposes `/auto/metadata/videos/...` under its existing route. It returns duration only for a current source ETag and verified Stream job. Existing processed jobs can lazily recover duration. Next.js reads only this fixed HTTPS origin and rejects redirects. [Cloudflare duration reference](https://developers.cloudflare.com/api/resources/stream/methods/get/).

## Acceptance and calibration

- Compare declared-interest relevance immediately after onboarding and after new behaviors in a new session. Existing session order intentionally stays frozen.
- Exercise seek, pause, tab hiding, speed changes, remounts and loops; check cumulative qualified watch receipts and unique milestones.
- Send duplicate, forged, delayed and canceled provider events. Confirm setup alone never becomes scheduling, cancellations retract scheduling evidence, and later paid receipts keep the correct source through refunds and source-post deletion.
- Verify free bookings do not add money or paid-sale counts. Separate currencies; count renewals as revenue on one purchase milestone.
- Verify Following chronology, creator bans during pagination, >2,000-post snapshots, exhausted inventory, cold-start exposure and creator variety.
- Compare `discover_measurement_v1`, `discover_revenue_v1` and `discover_variety_v1` by topic and offer type. Do not compare free-call bookings directly with paid purchases as one conversion type.
- Pre-register a minimum detectable improvement and sample size, and allow conversion follow-up before judging a variant. Report confidence intervals, category coverage, creator concentration and repeated exposure alongside paid conversion. Fit/tune on one sample and validate on a held-out period/group; do not promote the ordinal pilot controls as calibrated weights.

## Verification performed so far

- Final selected regression run: **61 suites / 855 tests passed**, including existing feed/payment/installment contracts and new attribution tests.
- PostgreSQL tests cover deletion/refund preservation, private checkout-link access and late payment-to-purchase binding. Provider link, signature and buyer-only redirect tests pass.
- Eight media-worker tests passed.
- Production Next.js build passed with placeholder backend credentials; this checks compilation/prerendering, not live integration.
- In-app browser displayed all eight onboarding options and simultaneous selection. Authenticated save/ranking/booking flows were not exercised in that browser because the local build uses placeholder credentials.
- New-source lint had no errors and four dynamic-query `any` warnings in `discoverServer.ts`.

No application deployment, production migration, scheduling-account configuration, or commercial-weight calibration has been completed.

Infrastructure audit: the existing CreatorNet Staging project has the installed payment/feed schema and recent search migrations. It is separate from the production project's empty development-branch list. No new project was created. After user authorization, the affected preference data and original feed functions were backed up locally. The first migration attempt rolled back because installed profile interests are JSONB, not text arrays. The migration and both database fixtures were corrected, and all 17 affected local database tests passed. All four migrations then applied successfully to staging. Archives contain all 3 profiles, 13 posts and 3 score rows; the score total stayed 1,236. Both feed functions have ban checks, canonicalization has no remaining mismatches, and client roles cannot read/write the private ledger or execute ranking evidence. A service-role transaction verified identity/session transfer, monotonic watch bounds, booking deduplication, cohort evidence and cancellation, then rolled back its records. Authenticated HTTP/browser integration and real scheduling callbacks remain outstanding.

Staging connector migration history uses versions 20260913022831 (taxonomy), 20260913022840 (events/sessions), 20260913022852 (verified sales), and 20260913022903 (eligibility/measurement). These map to the four local migration files in the same order; reconcile migration history before using CLI deployment against this staging project to avoid replaying them under local timestamps. The rehearsal left zero session, event, identity-link and booking-attribution rows.

Preview hosting was recovered from prior task evidence and verified in the signed-in Vercel dashboard. Project creatornet-mvp (prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA) has a general Preview Supabase URL pointing to nwqfofezfzljhxolkycz. The previously used staging branch is admin-refund-allocation. This work will use feat/discover-conversion-ranking. Event attribution now includes captions and active legacy product links, matching ranking context; two regression cases cover active and inactive linked offers.
