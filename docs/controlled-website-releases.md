# Controlled website releases

The product remains in this repository. No scheduler, calendar, release date, batch, or provider operation is created by this package.

## Initial state and ownership

The additive migration initializes `hidden=true`, every public feature false, and an empty tester list. Owner: verified account `noahjimenezz`, UUID `767658b6-7b2a-4cc4-91b4-6a0f78073a8e`, confirmed for this change. Other administrators do not qualify for release management. Tester approval does not modify profile roles.

The Discord invite supplied for activation is `https://discord.gg/bKC8q4z6B`. It must be entered and saved through `/admin/releases` before activation. Updates validate it against Discord; closing an already configured website remains possible during a Discord outage. Invite verification is time bounded: the currently supplied invite expires November 19, 2026 at 5:57 PM America/Phoenix. Recheck validity immediately before activation.

## Enforcement

`proxy.ts` applies the shared server policy to direct URLs, API methods, RSC requests and unknown routes. Auth identity comes from the existing verified Supabase helper, including supported bearer tokens. Cookie presence and user metadata do not authorize private access. Server actions are closed; the current product has no server actions. New actions require an explicit reviewed policy before introduction.

Unknown routes stay private even when individual public features open. Feature flags require a complete known-key boolean map and valid dependencies. The master hide setting overrides every public feature without changing the map. Existing financial/readiness/entitlement checks remain mandatory.

Restricted pages return standalone launch HTML, so product components, navigation, previews, providers and product-data requests never run there. Authentication, legal/support and buyer fulfillment use minimal chrome. Settings and tester reads have no cross-request cache. Private HTTP responses use browser/CDN no-store and noindex headers. Sitemap and robots follow the current release policy, with no product lookup while hidden.

The private configuration tables enable RLS and revoke all client-role privileges. Mutations lock the singleton row, require the exact owner, reject stale revisions, and write the existing `admin_actions` audit row in the same transaction. An audit failure rolls the mutation back. No account is automatically added as a tester.

## Narrow exceptions

Exact signed operations: POST `/api/stripe/webhook`, POST `/api/webhook`, GET `/api/installments/collect`, GET `/api/memberships/collect`, GET `/api/memberships/recover-exits`, GET `/api/scheduling/google/jobs`, GET `/api/scheduling/google/sync`, GET `/api/scheduling/google/maintenance`, and POST `/api/scheduling/google/notifications`. Their handlers still authenticate signatures, cron credentials or notification tokens. No entire API section is exempt.

Verified buyers retain their library, purchased delivery/playback/download/progress, paid-call scheduling, saved booking management, payment confirmation and membership/payment recovery. Existing handlers recheck ownership and readiness. New purchases, new leads, new membership enrollment, public discovery and publishing are separate public features. A booking continuation requires a saved buyer-owned purchase/reservation/attribution; the booking handler also rechecks the matching creator/calendar and entitlement. Library creator names are restricted to creators in that buyer's purchases. View-count continuation requires each requested post to match that buyer's supplied purchase IDs.

Previously shared media URLs remain unchanged at the media/storage service. This package hides the website and its endpoints; it does not erase public history or privatize media storage.

Already-started setup retains only GET `/api/stripe/connect/return`, GET `/api/stripe/connect/refresh`, and GET `/api/scheduling/oauth/callback/{calcom,calendly,google}` for verified accounts. The existing handlers require a saved Connect account or an unexpired user-bound OAuth attempt plus matching state cookie before proceeding. New account onboarding and OAuth-start routes remain restricted. No callback is invoked during automated verification.

## Deployment and acceptance gates

1. Run affected tests, scoped lint, TypeScript, selector safeguards, media-worker safeguards, the full suite and the standard CI production build. Record the exact commit and environment for each result.
2. Review the exact migration source/hash and current database before its single separately approved dispatch. Never run a blanket database push. Preserve existing users, posts, purchases, media and financial tables. The migration must reach every database actually used by the candidate deployments; do not assume a Preview database is separate.
3. Deploy the reviewed candidate to Preview. Verify launch markup/network behavior, private email sign-in, the confirmed owner, approved/revoked testers, forged cookies, APIs/direct URLs, dependency toggles, immediate master hide, no shared cache, and narrow fulfillment/job exceptions. Local mocks/SQL fixtures do not establish hosted acceptance. Do not send emails, create provider purchases/jobs, or repeat earlier financial tests without exact authority.
4. Save the valid Discord invite from the owner screen and leave hidden=true, all public features false, no automatically approved testers.
5. Inventory and verify all three Vercel projects (`creatornet-mvp`, `creatornet-mvpv2`, `nextjs-7fjq`), both production domains, project aliases and historical deployment URLs. Representative latest/oldest generated deployment URLs require Vercel authentication; the three project aliases redirect product pages to `www.creatornet.net`. Their API routes do not redirect, so the candidate must deploy to all copies or those endpoints must be separately protected. One historical alias has a public `alias-protection-override`: `creatornet-mvp-git-feat-discov-6491dd-nrjimenez2-codes-projects.vercel.app` (deployment `dpl_Bw7mjrcmwcnabhdLrszsJEpJK3Dg`). At the separately approved release, point this exact alias to the guarded release so any existing callback URLs remain usable while its old website stops being public. Do not remove the override or revoke the three `automation-bypass` credentials. Recheck the alias anonymously before claiming complete coverage. Actual registered provider webhook URLs have not been inventoried through a provider connection; preserving these URL identities avoids depending on that unknown.
6. Obtain the plan's separate Production activation approval only after the candidate and evidence are reviewable. Merge/deploy the exact tested revision through the existing workflow, verify all copies at that revision, then verify both public domains and private owner access. A Ready deployment alone is insufficient.

## Evidence boundary and no-repeat rules

Implementation and local verification do not mean CreatorNet is hidden in Production. No hosted schema mutation, merge, production deployment, release schedule, payment, media transform, invite send, or credential change is implied by this document. Existing playback remains based on main `85bbcf50b84a9c5ba935d1e2c778b6a1ac0d9048`. Its earlier physical-device waivers remain historical and unverified; this package does not repeat or upgrade them.

Reuse the saved Vercel inventory and anonymous exposure receipts. Do not rerun completed migrations, recreate test purchases, dispatch duplicate CI runs, or stop admitted jobs to reconstruct context.
