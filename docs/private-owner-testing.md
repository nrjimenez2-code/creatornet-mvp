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
