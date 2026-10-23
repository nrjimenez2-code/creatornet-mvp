# CreatorNet security hardening — 2026-10-22

Baseline: main `12ea0c08dd4d2fbe2e6e275f75df0ab90d71fc30`, after PR #271.
This change preserves release controls, existing sessions, product/payment identities,
service jobs and current financial contracts. Public access remains hidden.

## Changes and evidence

- Browser OAuth uses PKCE so an unsolicited implicit-token fragment cannot substitute
  another user's session. Existing email-code sign-in and stored sessions are retained.
- Admin moderation/report mutations require a matching Origin before authentication,
  database access or email dispatch. Synthetic tests cover hostile sibling origins and
  legitimate same-origin requests.
- Public R2 uploads require an owned, single-file key and validated byte size. Presigned
  requests sign Content-Type and Content-Length. Post validation never deletes a
  caller-supplied storage key, and owned R2 validation fails closed when metadata is absent.
- Booking deletion rejects any payment history, including concurrent inserts. A database
  RESTRICT foreign key protects history even if application checks race.
- Payment-link issuance checks that booking, post and product have the same creator before
  entering either payment implementation. This prevents fabricated bookings from routing
  another creator's product through the wrong seller.
- Client booking writes are revoked; existing owned recovery reads and server-authorized
  creation/cancellation remain. Product identity columns cannot be client-supplied or
  changed; generated-ID legacy creation and existing mutable product fields remain.
- Five legacy views/materialized views lose unused client privileges; four ordinary views
  use caller RLS. The old post_freshness view allowed anonymous deletion in a synthetic
  reproduction despite base-table RLS. No hosted destructive probe was run.
- Three unused SECURITY DEFINER feed RPCs lose client execution because they omit current
  moderation/engagement checks. Current application clients call get_feed_v3. Service-role
  access, signatures and bodies remain. Ten SECURITY INVOKER routine lookup paths are pinned.

Current private release gates block ordinary external users from the latent upload,
payment-link and feed-reopening paths. These findings are not evidence of exploitation.
The database grant issues are closed independently of those gates.

## Verification and release order

Run focused Jest for changed auth/admin/media/payment/database contracts, scoped ESLint
and TypeScript. Required CI retains full-suite fallback, selector safeguards, media-worker
checks and production build. Local synthetic database proofs do not establish hosted proof.

Apply each reviewed migration exactly once to the primary project, after checking the
actual source, migration ledger and current database metadata. Never blanket-push this
repository's historical migrations. Shared Staging is outside this change.

1. `20261023015433_preserve_booking_payment_history.sql`: only replace the reviewed
   booking_payments FK from ON DELETE CASCADE to RESTRICT, atomically with short lock timeout.
2. `20261023015517_broad_database_security_hardening.sql`: only the listed grants/view
   options and ten routine configuration changes; no row or function-body rewrites.

Record dispatched SQL byte hashes, hosted migration versions, role-contract results,
row identity hashes, unchanged function bodies/policies/release settings and exact tested
Git tree. On an uncertain result inspect the ledger and catalog before any retry.
Merge the exact green head, wait for main CI and all three normal Production builds,
then verify canonical and legacy public routes plus preserved deployment protection.

## Recovery

Both migrations are transactional and fail before commit on their documented drift checks.
An application rollback must retain database security fixes and historical payment rows.
Do not restore CASCADE, client booking DML, identity mutation or anonymous view writes to
work around an application failure. If an unanticipated dependency appears, prefer a
narrow server-authorized replacement or targeted forward fix after catalog inspection.
Do not execute restores, issue new provider operations or modify financial identities.

## Scope and remaining assurance

Supabase leaked-password protection was enabled separately through the authenticated
dashboard and its security advisor warning disappeared. Passwords and sessions were not
changed. Seven scheduled database backups were visible (Oct 16–22); no restore was tested,
and database backups exclude Storage object contents. Public preview media remain public.

CreatorNet has no app-level MFA enrollment/challenge/recovery flow. Protecting the owner's
email/social-provider and hosting/database operator accounts with MFA remains an account
hardening concern; their provider MFA state was not verified. Do not enforce AAL2 without
enrollment/recovery support or disrupt active owner sessions.

Actual Google/Apple OAuth and real R2 signed PUT acceptance require provider/browser
acceptance beyond synthetic tests. No purchase, refund, transfer, new OAuth credential,
notification, tester change or real upload is part of this release's checks.
Existing production dependency audit was clean; the unfixed development-only braces
advisory from PR #271 remains documented rather than suppressed. citext in public and
intentional caller-bound SECURITY DEFINER routines need individual assessment, not blanket
relocation/revocation. No audit establishes that a platform cannot be hacked.

Primary technical references: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Supabase password security](https://supabase.com/docs/guides/auth/password-security),
[Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[AWS request presigner](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/).
