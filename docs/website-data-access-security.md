# Website data access security

The website proxy does not protect direct Supabase requests. The database migration
`20261023004846_website_data_access_guard.sql` applies the same saved release state
to direct product-data reads and public RPCs. It does not alter the blank/Coming
Soon selection or the saved feature switches.

## Enforcement

- Restrictive policies combine with the existing policies using AND. Adding a
  permissive policy would leave older public-read policies effective.
- Product-table policies apply to direct REST requests, embedded relations,
  GraphQL and any future Realtime publication of those tables. No product table
  was in the `supabase_realtime` publication at the verified release baseline.
- A PostgREST pre-request hook checks public RPC calls. This is necessary because
  legacy SECURITY DEFINER feed functions bypass caller RLS. Unknown public RPCs
  default to private access. The migration refuses to replace an existing hook.
- Private access uses the signed request identity, verified Auth record, ban
  status, and saved owner/tester list. User-editable metadata and RPC actor
  parameters cannot confer private access. Tester revocation takes effect on the
  next request without waiting for JWT refresh.
- Public feature checks use the same flag validator and dependency rules as the
  owner controls. `hidden=true` overrides saved public flags. Private identities
  retain access while hidden.
- Existing grants and permissive ownership policies remain necessary. These
  restrictive policies do not grant broader permissions to any table.

## Preserved operations

Buyer-owned purchases, watch progress and booking records retain their existing
policies. A verified buyer can still read preview metadata for their own purchase;
a creator can read their own preview metadata. These exceptions do not grant
premium delivery: the existing server entitlement readers still decide access.
Suspension does not remove purchase-recovery metadata. Own-profile reads remain
available so existing server ban checks can read the ban status.

Service-role fulfillment and background jobs bypass client gates. Auth and its
callbacks are separate from the Data API hook. Storage policies and existing
public media URLs are unchanged. No financial identities, accepted terms,
credentials, provider operations or product rows are modified by this migration.

The pre-request hook protects PostgREST, not Storage or Realtime. Public Storage
media links are an explicit preservation requirement; the table policies protect
product metadata independently of the hook.

## Dependency updates

Next.js 16.4.2, sharp 0.35.5, Sentry 10.76.2, DOMPurify 3.4.17 and compatible
transitive fixes replace the audited vulnerable Production baseline. The source
pins Next.js/Sentry/ESLint config and commits the exact lockfile. A same-major
brace-expansion override removes its obsolete nested copy.

The Production dependency audit must exit 0. The development-only `braces`
3.0.3 finding remains through ESLint's glob tooling, with five affected package
entries for one underlying parser issue. There is no compatible fixed upstream
release at preparation time. App source and CI supply the glob patterns; public
requests do not reach that parser. Do not downgrade ESLint/Next.js, remove tests,
or suppress the advisory to obtain a zero count. Recheck when a fix is published.

## Verification and deployment

1. Run the real PostgreSQL role/RLS integration tests in
   `__tests__/website-data-access-guard.test.ts`, the release-control suites,
   typechecking/lint and the required full CI/build.
2. Immediately before the hosted change, verify the expected main/Production
   revision, release settings, empty pre-request-hook setting, existing
   permissions/policies, row sentinels and other chats' hosted-write boundaries.
3. Save a one-time dispatch receipt with the exact migration hash. Apply that
   migration once to the primary project after the checks pass. Reconcile the
   original operation if its outcome is uncertain; do not dispatch again.
4. Verify anonymous direct posts/feed denial and normal owner access, bought-row
   recovery contracts and service-role access. Check approved/revoked identities
   in the isolated fixture without changing real tester membership unnecessarily.
5. Merge the exact tested source revision and observe the existing Git deployment
   workflow on all three projects. Preserve the blank page, protection and legacy
   alias identity. Perform the affected live checks and record exact deployed
   versions. No repeat financial/provider QA is necessary for this change.

## Rollback

Use only if verification identifies a regression caused by this migration.
Rollback deliberately reopens the original audited access gap. Retain the
patched application dependencies if they are healthy.

The companion `scripts/rollback-website-data-access-guard.sql` removes only this
migration's policies/helpers and resets the request hook after verifying that the
hook is still this change's hook. It uses a transaction, drops no product data,
and does not modify saved release settings. Do not use CASCADE or blanket policy
removal. Save before/after metadata and recheck affected owner/buyer paths.
