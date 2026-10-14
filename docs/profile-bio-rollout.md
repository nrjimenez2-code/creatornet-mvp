# Centered profile bio, mentions, and website rollout

Own and public profiles use `ProfileBio`: centered 16px system text, 23px line height,
preserved line breaks, case-insensitive public mention links, and one external website.
The editor keeps plain-text bios (600 characters) and supplies account-only suggestions
after 250ms, with keyboard/pointer selection, cursor restoration, cancellation, and failure fallback.
Mentions track the username written in the bio; no notifications or permanent tags are created.

## Schema before Website activation

`NEXT_PUBLIC_PROFILE_WEBSITE_READY` defaults off. In that state profile reads and saves
omit `website_url` and the editor omits the Website field. Centered bios and mentions
work independently. This protects automatic Git Previews against unmigrated databases.
Do not infer the database target from a Preview URL or masked environment metadata.

1. Authorize a specific non-Production database and verify its ownership/availability.
2. Check profile columns, RLS, UPDATE policies, and effective column permissions there.
3. Apply **only** `supabase/migrations/20260930022954_profile_website.sql`.
   It aborts on disabled RLS or broad profile grants; resolve that prerequisite through
   the environment owner, without changing shared permissions as part of this feature.
   It adds a nullable column, a URL/length constraint, and authenticated UPDATE on that column.
   Existing rows remain null; there is no backfill and no new INSERT grant.
4. Verify owner update/read/clear, cross-user denial, anonymous denial, and protected-column denial.
   Verify public profile rendering through the existing server client.
5. Only after schema/permission acceptance, set `NEXT_PUBLIC_PROFILE_WEBSITE_READY=true`
   **for the intended branch/environment** and rebuild its Preview. The flag is inlined
   at build time on both server and browser; changing it requires a new build.
6. Sign in and accept desktop/mobile profile and editor behavior before requesting release.

Production migration, activation, merge, and release each require explicit Production scope.
An application rollback can leave the nullable column in place. Disabling the build flag
also stops Website reads and writes; it preserves stored URLs for later reactivation.

## Hosted observations at implementation start

Read-only inspection on September 29, 2026 found no `website_url` in Production
`rvkqxgghqitkwzdsuclz`, Staging `nwqfofezfzljhxolkycz`, or Staging Migration Rehearsal
`hmtbtzxpkaxmwqkuhlrd`. Production's existing owner UPDATE policies and column grants
protect IDs, roles, Stripe fields and earnings. The two inspected test databases have
broader UPDATE grants than that Production baseline; the migration intentionally refuses them.
No hosted migration, profile edit, permission repair, credential extraction, or financial operation
was performed as part of implementation. Catalog snapshots can drift; recheck at execution.

## Acceptance evidence and limits

Jest exercises real PostgreSQL statements in an isolated in-memory PGlite fixture modeled on
the inspected Production profile RLS/grants. It applies the actual migration and checks
owner persistence/clearing, cross-user and anonymous denial, protected columns, invalid URLs,
and atomic rejection of permission drift. This is local fixture evidence, not hosted Supabase proof.

Other scoped suites cover escaping/line breaks, case/punctuation/email handling, unknown and
ambiguous handles, bounded public account reads, rate limits, suggestion debounce/keyboard/click,
stale-response cancellation, failed lookups, editor loading protection, avatar cropping, save failure,
website normalization/clearing, schema-off saves, navigation, galleries, and Posts/Offers behavior.
Required CI retains the full-suite fallback for this behavioral/backend change.

Signed-in Preview acceptance must include own/public headers, 320px narrow screens, long bios
and URLs, blank bio with a website, keyboard access, pointer/touch selection, cursor placement,
mention navigation, external navigation, and save/refresh/clear. Capture desktop and mobile
screenshots against `creatornet-profile-bio-centered-mockup.png` from the approved planning chat.
Its sample bio, mention and URL must never be copied into an actual user's profile.
