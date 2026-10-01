# Composer and private product delivery

Candidate: exclusive publish-time Buy, Book, Tip, or no action; product-priced Buy; ordered private videos and labeled links; immutable purchased delivery; zero-dollar cardless Book; private Stream uploads and purchased playback. The forward migration preserves existing premium storage keys and payment identities.

## Configuration and release sequence

Deploy the application with both readiness flags off. Apply only the reviewed 20260930175120_composer_premium_delivery.sql to the explicitly approved database. Do not run a blanket migration push. Record the database ref, provider migration version, SQL SHA256, before/after catalog and backfill counts, RLS/grants, triggers and function signatures.

After schema verification, set CREATOR_PREMIUM_DELIVERY_SCHEMA_READY=true. This enables completed-purchase delivery independently of creation. Enable CREATOR_PREMIUM_DELIVERY_READY only after authenticated TEST/private-media acceptance.

| Server setting | Requirement |
| --- | --- |
| PREMIUM_STREAM_ACCOUNT_ID | Approved existing Cloudflare account, 32 hexadecimal characters |
| PREMIUM_STREAM_API_TOKEN | Account-scoped Stream read/write/delete permission, server secret |
| PREMIUM_STREAM_SIGNING_KEY_ID | Approved RSA Stream key ID |
| PREMIUM_STREAM_SIGNING_JWK | Base64-encoded private RSA JWK from that key, server secret |
| PREMIUM_STREAM_PLAYBACK_HOST | Exact customer-…cloudflarestream.com host for the same account |

Never prefix private settings with NEXT_PUBLIC. Preserve Stripe TEST/LIVE identity, webhook, fee, consent, monthly mentorship, fixed-service and paid-call gates. This implementation does not authorize enabling those services. New free Book uses checkout.session.completed without a PaymentIntent. Its private checkout receipt and existing attribution reader do not create purchases, earnings or a scheduled call. In-flight setup-mode bookings remain supported.

Creators use authenticated, ownership-filtered product interfaces. Ordinary Data API readers retain sales columns. Legacy product delivery URL columns and all new delivery tables are service-only; existing row policies remain in place. New private products require ready saved delivery before publishing.

## Upload recovery and purchased access

TUS creation requires signed access immediately and reserves detected duration plus 2% (at least ten seconds), capped at 36,000 seconds. Files are strictly below 30,000,000,000 bytes. The client uses 8 MiB chunks, HEAD offset recovery, bounded retry and pause. Reopening requires reselecting the same original file.

Create the durable asset ID and creator/file fingerprint before the provider request. An uncertain creation preserves that identity. Recovery searches the exact creator and asset name, without a second reservation. A lost upload URL requires cancellation of the reconciled UID before retrying. No observed provider result stays held until the six-hour expiry. Known provider rejection marks the asset failed. Cancellation remains canceling until provider deletion succeeds; Retry cancellation uses the same UID.

Ready assets cannot be deleted through draft cancellation. Immutable product revisions and purchase snapshots plus foreign keys preserve included videos. Standard Checkout freezes delivery before opening Stripe. Monthly/guarded installment reservation inserts freeze delivery before Checkout while preserving financial order fields. Later receipt accounting updates leave purchased content unchanged.

Playback/download authenticate and recheck buyer ownership, paid access, disputes and existing membership time limits, including the old signing endpoints. Tokens last at most fifteen minutes, shortened to remaining paid time. Renewal occurs one minute before expiry (halfway through tokens shorter than two minutes) and preserves position, play/pause and speed when the new token arrives. Denied access pauses and removes the old source. Explicit entitled download requests generate or retry failed MP4 for the same video; ready signed download URLs carry downloadable permission. Legacy premium-bucket downloads remain available.

## Proposed validation budget

[Stream pricing](https://developers.cloudflare.com/stream/pricing/) is $5 per 1,000 stored minutes/month in blocks and $1 per 1,000 delivered minutes: $0.30 per stored hour/month and $0.06 per full hour delivered.

September 30 read-only receipt: account 09c059503967a4e861c32fa0d5b06ee0 had 14 videos, 7.32 used storage minutes and a 1,000-minute limit. This is a point-in-time capacity observation, not approval for uploads, signing keys, credentials, extra storage or delivery spending.

Propose 5-, 30-, 60-, 120-minute fixtures plus three additional five-minute lessons. Reuse the hour fixture for the $50 masterclass and the four short lessons for two- and four-video bundles. Retained duration is approximately 230 minutes; initial reservations approximately 235 minutes. Upload sequentially and record actual usage. Proposed incremental delivery cap: $1, with no new storage block. Stop before exceeding an approved cap. Keep fixture asset/UID receipts; preserve existing resources.

## Rollback

Disable CREATOR_PREMIUM_DELIVERY_READY to stop new private posting/checkout. Keep schema readiness, signing configuration, entitlement readers and delivery routes enabled for completed purchases and free Book receipt confirmation.

Keep all forward tables, asset/UID identities, revisions, purchase bindings, original storage keys, Stripe sessions/order IDs and financial receipts. Do not drop the migration, disable signed access, reset a rehearsal database, detach purchases or restore public delivery-column grants.

Retain the new authenticated product/delivery interfaces when rolling the application back: older creator clients that directly select restricted product delivery columns are incompatible with the new grants. Any further schema rollback needs a reviewed forward fix and explicit database scope.

## Acceptance evidence

Separate local, CI, hosted TEST, desktop browser, physical-iPhone and Production receipts. Hosted receipts need exact database/Stripe TEST account, creator/buyer, post/product/revision/order/purchase/session/asset/UID, webhook event and ledger cardinality; refusal of public URLs; canceled/pending/refund/dispute/membership denial; matching $50 composer/button/Checkout pricing; zero Book total/no card/no PaymentIntent/calendar time still unselected.

For real uploads record bytes, detected/provider duration, committed TUS offsets across interruption and composer reopen, cancellation/failure, late seeking, token renewal with preserved playback, independent bundle progress, protected generated MP4, legacy Supabase playback/downloads and Discord/Whop delivery. Paid-call scheduling remains payment-protected and separately gated.

Required checks: affected Jest, scoped ESLint with independently reproduced base diagnostics, TypeScript, PostgreSQL ownership/constraints, selector/media safeguards, full CI and build. Synthetic builds, mocked provider responses and local PostgreSQL are not authenticated Preview, hosted media or physical-device acceptance.

Production, provider spending/credentials, paid-call activation and any new QA database/branch remain explicit approval checkpoints after package review. Preserve separate mentorship/tipping/capacity work; do not repeat their completed operations.
