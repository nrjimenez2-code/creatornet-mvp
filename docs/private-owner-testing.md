# Reusable private owner testing

Use this existing protected address for owner testing:

https://creatornet-mvp-git-codex-feed-b4db54-nrjimenez2-codes-projects.vercel.app/auth

It is an alias, so successive reviewed test builds can use the same bookmark.
It reuses the existing primary project, owner account, backend and email setup.
No new account, API key, database, paid plan or public activation is required.
The working configuration uses real existing services and product data; ordinary
build, email and page traffic count toward existing service usage.

## Ownership and candidate updates

This chat's merged `codex/feed-hydration-20261024` branch originally created the
alias. Reserve it for this manual testing channel and keep that old branch
retired. Work on new task branches. Pushing or redeploying the old branch can
automatically replace the alias with an ordinary Preview whose configuration
does not support this private owner flow. Verify the alias target before use.

Inventory on October 25, 2026 inspected all 619 aliases across the three existing
projects. No dedicated generic private-testing alias existed. This suitable
existing alias was reused; financial/mentorship origins and other chats' aliases
were preserved.

For a new candidate:

1. Reconcile current main, the exact reviewed commit/tree, applicable CI and
   existing deployment receipts. Reuse a suitable Ready build before building.
2. When an authorized new build is needed, use the primary project
   `prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA` in team
   `team_XnmQuYar6rBtKo5e1apgauky`, with the working configuration kept in place.
   Stage it protected and unpromoted (`--prod --skip-domain`). Do not copy secret
   values or change Preview database/schema configuration as a shortcut.
   Record a fresh one-time dispatch journal and verify uploaded source identity.
3. Confirm the build is Ready and matches the intended source. Reassign only the
   alias above to that deployment using the existing authenticated Vercel tools.
   Preserve its alias UID and inherited project protection; do not add a bypass.
4. Verify the exact alias target. Anonymous requests must encounter Vercel
   Authentication. With authorized platform access, the application must still
   deny anonymous/unapproved product access. Verify normal owner sign-in,
   navigation and the affected feature in the browser.
5. Keep `www.creatornet.net`, `creatornet.net`, the recorded legacy public alias,
   release settings, tester grants and protection settings unchanged. The
   generated project alias may follow a staged Production-configured build;
   reconcile it and cron ownership using the existing staging runbook. Never
   promote a private candidate or invoke jobs merely to test this bookmark.

## Saved login and evidence limits

Use the same owner account. Never copy cookies, tokens or sessions between
addresses. A first visit to this address can require one normal emailed code;
enter it directly in the website. Later candidate updates at this same address
can reuse its existing login. Sign-out, a new browser or an expired/revoked
session can still require another normal code. A branch change does not itself
require new service keys or a new account.

The ordinary Preview configuration mismatch is separate from this working
channel. Do not use old unique deployment URLs as the reusable bookmark, or
repair shared Staging through unreviewed migrations. Record the candidate SHA,
deployment, alias verification, owner/browser checks, runtime findings and
before/after privacy checks for each change. Preserve prior one-time receipts.

## Private Apple sign-in capability (default off)

`PRIVATE_APPLE_SIGN_IN_ENABLED` is a server-only UI switch. Only the exact value
`true` allows `/api/release/session` to include `privateAppleSignInEnabled: true`,
and only when valid release settings are available and public registration is
closed. Otherwise the response retains its original three fields. Responses
remain private and uncached. The browser accepts only literal boolean `true`
from a successful response and starts with this capability disabled.

This exposes the existing Apple OAuth button while keeping Google and public
registration messaging gated by registration. It grants no product access and
does not prevent Supabase from creating users or automatically linking identities.
Manual identity linking being disabled does not establish that automatic linking
is disabled. Keep this switch absent or disabled until the gates below are met.
Never use a `NEXT_PUBLIC_` variable or a client assertion as signup prevention.

Before any activation, record the exact deployment and obtain separately scoped
authorization for provider settings, negative acceptance and the private release.
Verify current server signup prevention and its effects on existing integrations.
Use an explicitly approved negative identity to prove no new user or unintended
identity link is created; do not assume an existing-owner success proves this.
Then have the human complete Apple sign-in using the already-linked owner through
the normal UI. Authentication dialogs, credentials and codes remain human controlled.
Verify the same owner, private access and normal profile-based destination; bare
`next=/dashboard` is not an allowed return, and onboarding alone is not a failure.
Google requires its own approved test identity and acceptance scope.

Do not open registration, change live Auth settings, enable this switch, deploy,
or move the reserved alias merely to test the local change. The required CI gates
and private release review precede activation. Removing or disabling the switch
and updating the affected deployment hides private Apple again; that UI rollback
does not undo provider changes, user creation, identity links or existing sessions.
