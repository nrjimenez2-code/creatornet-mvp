# Administrator authenticator access

Administrator pages/APIs and Release Controls require a verified TOTP session.
Mutations additionally require a TOTP verification within the past ten minutes.
The server verifies the exact token and current factors; no user metadata, UI
flag, absent-factor exception or different credential may grant assurance.
Ordinary owner private access, profiles, feed, purchases and fulfillment retain
their existing access rules. `/account/security` and its minimal status endpoint
bootstrap the saved owner/admin at AAL1, outside the administrator layout.

## Owner enrollment and acceptance

Open `/account/security` in the owner's own authenticated browser. Complete
other device work before accepting the enrollment warning: Supabase documents
that verifying a new factor signs out other sessions. The owner scans the QR
code, privately enters its code in the app, and adds/verifies an independent
backup authenticator. Never send QR images, secrets, tokens or codes to chat,
logs, analytics, evidence screenshots or repository files. Setup material is
only held in component memory and cleared immediately after verification.
The security subtree uses `sentry-block`/`data-sentry-block` and PostHog's
`ph-no-capture` so replay recording excludes both text and QR image attributes.
Incomplete enrollments are listed from the SDK's `all` factors array (its
`totp` list contains verified factors only). Review/cancel an unverified setup
before replacing it; an uncertain enrollment response is not blindly replayed.

Successful verification can also invalidate another browser's session that has
not completed MFA. Keep a fresh-sign-in recovery check in one browser session;
verifying in the original browser during that check can invalidate the test
session. A `session_not_found` failure requires a fresh normal sign-in, not new
factors or repeated codes. The UI distinguishes invalid sign-in, rate limiting,
invalid TOTP and other verification failures without showing provider details.

Explicit MFA actions use public SDK fetch/storage adapters to bind requests and
the resulting session commit to the original stored sign-in. A concurrent
sign-out, replacement account, or another tab's storage update discards a late
verification response. Normal non-MFA authentication delegates unchanged. The
UserProvider also ignores superseded MFA events after a newer session wins.

The existing locked SDK supports TOTP. Its installed version has no recovery
codes API; newer documentation's experimental recovery codes are not enabled.
The UI refuses removal of the last verified factor. Supabase's direct factor
API can still remove it from an AAL2 session; this cannot create an AAL1 admin
bypass because both server and database administrator overrides require AAL2
and a currently verified TOTP factor. Do not claim UI removal rules are a
provider-side last-factor restriction.

## Recovery

Use the backup factor after normal email/social sign-in. If all factors are
lost, no app endpoint resets them and email access alone is insufficient.
A trusted, separately authenticated project operator must verify identity
out of band and arrange a narrowly scoped, explicitly approved Auth factor
recovery through the supported Supabase administration tools. Reconcile exact
user/factor IDs and session revocation consequences before any operation.
Do not disable MFA globally, alter owner IDs/roles, reopen the site, or add an
email-only bypass. After recovery the owner enrolls a replacement and backup;
administrator controls stay unavailable until factor verification succeeds.

## Verification boundaries

Local synthetic tests verify token binding, AAL/factor/freshness denial,
bootstrap availability, guarded API mutations, cookies/event handling and
database RLS. They do not enroll real factors. Hosted migration acceptance,
owner-controlled primary/backup enrollment, new email/Google/Apple sign-in,
expired-code errors, browser reload/second-tab cookie synchronization and
physical device recovery require separate evidence. Native clients must
handle MFA-required 403 responses before invoking administrator controls;
ordinary purchase/fulfillment routes acquire no MFA requirement.

Official references: [Supabase TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp),
[enrollment and session effects](https://supabase.com/docs/reference/javascript/auth-mfa-enroll),
[factor removal](https://supabase.com/docs/reference/javascript/auth-mfa-unenroll),
[assurance validation](https://supabase.com/docs/reference/javascript/auth-mfa-getauthenticatorassurancelevel).

## Release order

1. Review local checks/CI and deploy the compatible application while the site
   remains private. Confirm `/account/security` bootstrap works for the saved
   owner at AAL1; AAL1 administrator controls now return actionable MFA errors.
2. The owner completes primary and independent backup enrollment and browser
   challenge/cookie checks, with explicit awareness of other-session effects.
3. Reconcile the existing `is_admin()` body MD5
   `943de565b8dc6c0817f3a0ce1a1ffe18`, owner/config/ACL and approved migration
   bytes. Apply `20261023030647_admin_totp_assurance.sql` once only after the
   compatible flow and owner acceptance are available. Its exact prior-state
   guard rejects replay or drift rather than replacing unrelated changes.
4. Verify AAL1 normal owned reads, AAL2 administrator override, service-role
   fulfillment, unchanged release settings, and primary/backup challenges.
   This checklist does not authorize reopening public features.
