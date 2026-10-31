# Supabase credential rotation without losing application HMAC state

The application historically uses `SUPABASE_SERVICE_ROLE_KEY` both as an API
credential and as HMAC material. Replacing it can change upload reservation
identities, anonymous Discover actors and pending email-code hashes. These are
different trust boundaries and need separate retirement checks.

This code change is preparation. It does not provision secrets, revoke a key,
invalidate an existing provider token or change hosted settings. A copied legacy
value remains trusted wherever it is still configured, including as HMAC
material after its API privilege has been removed.

## Server-only settings

| Setting | Purpose | Fallback when absent |
| --- | --- | --- |
| `ABUSE_HMAC_KEY` | Actor/IP hashes, upload operation and contract hashes | `SUPABASE_SERVICE_ROLE_KEY` |
| `DISCOVER_ACTOR_HMAC_KEY` | Anonymous actor cookie/header signatures | `SUPABASE_SERVICE_ROLE_KEY` |
| `EMAIL_CODE_HMAC_KEY` | Application six-digit email-code hashes | `SUPABASE_SERVICE_ROLE_KEY` |

These settings have no `NEXT_PUBLIC_` prefix. Each selected key must contain at
least 32 characters. An explicit empty or short setting fails closed; it does
not select the legacy fallback. Discover now rejects a missing/short legacy
key too. Real provider keys exceed this minimum; synthetic local fixtures must
also use an adequately long key.

Key bytes, encoding, domain prefixes, RPC names and RPC arguments are preserved.
The application does not trim or decode the selected string, verify with multiple
keys, retry an admission RPC with another key or reset counters. Configuration is
resolved when the existing HMAC operation runs, not by an import-time assertion.

`SUPABASE_AUTH_SECRET_KEY` is separate: the email adapter uses a modern provider
credential for forwarded client IPs. Its selection and provider behavior are
unchanged. The HMAC settings do not replace any Supabase API credential.

## 1. Establish custody and the actual consumer map

Complete owner-controlled login, MFA and recovery first. Inventory account PATs,
OAuth grants, Dashboard sessions and project credentials separately. Enabling
MFA or removing a member does not revoke a copied owner API token.

For every affected project and environment, record the serving revision and
consumers of API keys, JWT verification material and these HMAC settings. Include
all Vercel projects, branch-specific Preview overrides, Supabase Auth/SMTP/hooks,
workers, scheduled jobs, CI and operator tools. Source searches are not proof of
complete hosted or dormant consumer coverage. Preserve project, bucket, Stripe,
account, object and scheduling identities and existing private-release controls.

Use metadata and approved private credential entry. Do not print secrets, pull
environment values for context, paste them in chat, expose them in command lines
or add them to receipts. Record presence, credential identifier, scope, consumer,
deployment SHA and outcome instead. Take a current site baseline and retain a
compatible rollback build before changing a credential.

## 2. Deploy the compatibility code before replacing API credentials

Review the exact diff and pass required CI, including its backend/full-suite
fallback and build. A protected Preview and a Production release are different
acceptance gates. Existing Preview builds do not prove Production configuration.

With the new settings absent, valid existing configuration derives the same
HMACs. Before the API credential changes, the credential custodian must privately
provision each HMAC setting with the exact previously used HMAC bytes in every
required environment. That temporary continuity value can be the old provider
key; it is still exposed signing material and must be retired in step 4.

Confirm a new deployment actually uses the settings. Check stable upload
operation recovery, returning anonymous actor handling, authenticated history
linking, pending email-code verification and the hook/lockout controls. Static
environment presence and unit tests do not prove a hosted consumer loaded the
right value. Do not retain compatibility indefinitely or label this stage
complete offboarding.

## 3. Replace and retire API capability

Provision replacement keys with appropriate scope through the provider's
supported process. Update all consumers and redeploy/restart as required;
server clients created at module load do not pick up an environment edit in an
already running build. Preserve the temporary HMAC continuity settings while
the API credential changes. Verify the approved application's data access,
sign-in, media and financial integration behavior without creating duplicate
transactions or replaying consumed fixtures.

Legacy `anon` and `service_role` keys are JWTs. Migrating to modern keys and
disabling the old `apikey` pair is not, by itself, proof that an old service-role
bearer JWT is unusable. Coordinate retirement of the old JWT signing authority
and all old verification secrets/caches according to the provider's supported
signing-key migration. Account for existing user sessions and every verifier,
including workers or hooks that verify JWTs themselves.

Record the exact old signing-key identifier with provider status **Revoked**,
not merely **Previously used**, and record how each verifier stopped trusting
it. Supabase documents ten-minute edge JWKS caching plus potentially ten more
minutes of client caching. Custom verifiers can retain trust longer; record
their actual cache purge, restart or expiry behavior. An expired sample JWT does
not independently prove retirement of the authority that signed it.

The approved bounded negative acceptance must cover both an old legacy `apikey`
and the old service-role JWT in `Authorization` with a modern publishable
`apikey`. Use a minimal non-mutating probe within the agreed scope, never log
credentials or customer data, and pair it with a successful replacement-key
control. An unrelated 401/403, outage, RLS-filtered empty result or old-apikey-only
failure does not establish complete retirement. Obtain provider confirmation
where the hosted validation semantics remain uncertain.

This procedure does not itself revoke retained refresh sessions. Provider
signing-key retirement and targeted application-session revocation require
separate acceptance. A banned user or an old session row must not be treated as
proof that all previously issued sessions were revoked; preserve user data and
use a supported provider session-revocation route.

Account PATs and CLI/OAuth tokens are additional credentials. Rotate those using
their own consumer and custody maps, preserving legitimate jobs. This document
does not retire them, database passwords, R2/Stream, email, payment, scheduling or
other provider credentials.

## 4. Retire the old application signing trust separately

Use fresh independently generated server-only HMAC secrets. Do not leave the
retired API credential as a permanent signer. Anyone holding that copied value
can still create matching hashes or Discover signatures while it remains
trusted. Changing an HMAC setting deliberately stops trusting the old value;
there is no dual-key acceptance in this patch.

Before switching, inspect current hosted state without exporting raw identities,
hashes, email addresses or secrets. Establish a bounded drain or an explicitly
designed state migration and prevent new work from straddling the cutover using
an approved operational control. This patch does not add a pause control or
perform that drain.

- **Abuse/upload admission:** Preserve existing reservations and their original
  resource IDs. Actor/IP/operation/contract hashes cannot be rehashed from stored
  digests without their original inputs. Quota windows include 60 seconds, one
  hour and 24 hours. The migration makes buckets older than two days and
  reservations older than seven days eligible for bounded cleanup; eligibility
  is not proof that cleanup ran or recovery is complete. Prove in-flight upload
  and worker recovery closure, and no quota reset/bypass or duplicate debit,
  before changing this key. Do not just wait seven days or delete the rows.
- **Discover:** Existing actor cookies can live 90 days, while feed snapshots
  normally live two hours. Changing the signing key rejects old anonymous
  cookies/header tokens and issues new actors. Drain snapshots and accept the
  intended anonymous-history transition explicitly, or design an atomic history
  migration. Do not silently accept old signatures indefinitely. Authenticated
  history linking and claimed-token rotation still need hosted acceptance.
- **Email codes:** A changed HMAC rejects codes issued with the old material.
  Stop/drain issuance for the ten-minute code lifetime and account for the
  30-second verification lease, 60-second resend interval and 15-minute
  attempt/lock state, or implement a separately reviewed transition. Do not
  retry verification under a second hash: each admission can consume an attempt.
  Confirm the native token hook, failed-finish token suppression and replay
  controls after the switch.

Record the final switch and positive/negative acceptance for each setting.
The local tests demonstrate configuration and HMAC behavior with synthetic data;
they do not prove current hosted drain, secret custody or provider revocation.

## Rollback and completion evidence

Keep a rollback build containing these selectors and the current independent
settings. After API-key rotation, an older build that ignores the selectors can
derive new hashes from the replacement API key and break continuity. A rollback
must also preserve data, reservations, integrations and the private holding state.
After revocation, reauthorizing an old exposed credential is not a safe rollback;
repair forward with an owner-controlled replacement.

Close this work only with evidence of current owner/recovery custody, complete
consumer coverage, compatible deployed revisions, replacement-key success, old
API/JWT rejection, old application-signature rejection, in-flight state acceptance
and unchanged site/release behavior. Preserve exact revisions, provider key IDs,
scope, times and sanitized receipts; exclude secret values.

Official references:

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Personal access tokens](https://supabase.com/docs/guides/platform/personal-access-tokens)
- [Platform MFA and recovery](https://supabase.com/docs/guides/platform/multi-factor-authentication)
- [Auth sign-out and session limits](https://supabase.com/docs/guides/auth/signout)
