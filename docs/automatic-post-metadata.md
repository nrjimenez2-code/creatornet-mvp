# Automatic post metadata, version 1

The simplified composer sends `classification_version: 1`. `/api/posts` validates that version, enforces the 300-character caption limit, and extracts canonical caption hashtags on the server. It ignores submitted category/topic labels for these posts. Unmarked clients keep their existing contract.

Immediate metadata uses the unchanged `matchInterestTopics` matcher on title, caption, hashtag topic inputs, and a server-verified linked product's public title/description. Public bio/tagline are fallback context only when direct sources produce no category. Learning interests are excluded. Empty metadata is valid; publishing makes no AI call.

The existing leased search-video queue uses the same `google/gemini-3.6-flash` model and AI Gateway file transport. Marked posts request speech, readable screen text, observable visual activity, and supported category/topic labels. Quotes must appear in the extracted text; visual evidence requires bounded timestamps. Category keys must belong to the existing eight-category taxonomy. Topic normalization and limits come from the existing helpers. Invalid output is a failed analysis, and the published post retains its immediate metadata.

When a valid video result arrives, metadata is recomputed from the current job's direct text/offer context and supported video labels. Bio fallback is applied only if this combination still has no category. A silent fitness demonstration can replace provisional ecommerce bio labels. Creator hashtags are never manufactured from inferred labels.

The classification prompt requires substantive support for each category and topic. Generic contact requests, motivational slogans, or lifestyle scenes alone should produce no video labels: a "leave your 9-5" overlay does not establish career instruction. Promotional videos can still support ecommerce or content topics through concrete discussion, and actual resume/interview guidance remains eligible for career skills. Audio and visuals are analyzed independently. The parser validates the output's shape and quoted/timestamped evidence; semantic compliance with this prompt requires bounded hosted verification and is not established by mocked tests.

## Migration manifest

Apply only `supabase/migrations/20260930031043_automatic_post_metadata.sql` after checking prerequisites on the approved isolated database. The CLI generated this filename using Supabase CLI 2.118.0. It adds `posts.classification_version` and private columns to the existing service-only `search_video_text_v1` record, adds marker protection/context/fingerprint/finish functions, and replaces the existing claim function. It performs no backfill or reset of existing attempts. Existing extraction-only clients continue using `finish_search_video_v1` unchanged.

Required existing objects: `posts`, `profiles`, `products`, `offerings`, `search_video_text_v1`, `claim_search_video_v1`, and `finish_search_video_v1`, with the columns referenced by the migration. Existing search setup is documented in `supabase/schema/058-search-relevance.sql` and `059-search-video-processing.sql`; these are prerequisites to inspect, not a replay instruction. Do not run a blanket migration push: this repository's older migration history is not a complete bootstrap.

The new finish function locks the post and its context sources, then atomically checks the live lease, SHA-256 context fingerprint, owner, public source, visibility, creator ban, and active state before updating post metadata and accepting the extraction record. It rejects stale results. Evidence, visual summaries, context, and usage receipts stay service-only. Visual summaries never enter `transcript`, `screen_text`, or their existing search-text expression.

The queue retains one active extraction, four-minute leases, three attempts per source, a thirty-minute retry delay, the 500 MiB cap, and the existing ten-minute duration check. Only `video_url` is supplied to the model; premium paths are excluded from classification context and from model inputs. Legacy public-media restrictions and extraction behavior are preserved.

## Algorithm compatibility

Ranking policy, weights, exploration, commercial attribution, engagement scoring, taxonomy and topic-matching rules are unchanged. Feed requests do not read analysis records or call providers. Existing session/event snapshots retain their metadata; future sessions consume updated `posts.interests`/`posts.topics` through existing reads. Existing posts receive no automatic metadata update.

## Hosted acceptance gate

Local PostgreSQL/WASM tests and mocked provider/browser tests do not establish hosted provider quality or access. The current implementation remains a draft until an isolated database, Preview resource binding, test account, fixture media, and bounded provider spend are approved. Shared Staging has active workstreams; Production and the older rehearsal/recovery projects are not implicitly available.

Proposed bounded run: up to eight new test posts, with at most six public clips of at most 30 seconds and 10 MiB each, one explicitly triggered extraction attempt per eligible video, no background cron during the run, no automatic retries, and a proposed total Gateway cap of USD 1.00. These are proposed limits, not authorization. Use text-only/topic, hashtag, speech, silent visual, mixed, unclear, profile-fallback replacement, and inaccessible-media failure fixtures. The inaccessible-media example must fail before provider inference. Never purchase credits or provision infrastructure to complete the run.

Bind only this feature branch's Preview to the named test resource. Inspect the target schema and migration history first, then apply only the new migration once. Inspect service-only grants and run the provider/fixture matrix. Record exact deployment revision, fixture IDs, actual usage/cost (Gateway generation IDs and usage lookup when the inline cost is absent), processing and queue delay, failure codes, and desktop/mobile screenshots. Prove post metadata readback and its consumption by the unchanged feed, plus whole-tag and transcript search compatibility. Stop at the spend cap or a resource/quality blocker.

No merge, Production migration/deployment, bulk analysis, permission changes, or old-post reclassification is authorized by this feature's implementation request.
