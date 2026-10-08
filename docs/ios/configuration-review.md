# Configuration review before hosted/device work

These are prepared configuration requirements, not applied settings or approvals.

## Hosted app API

Choose an authorized backend environment and exact source revision. Set `CREATORNET_IOS_API_ENABLED=true` only for that reviewed environment once its enabled endpoints/security checks pass. For browser development only, optionally set `CREATORNET_IOS_DEV_ORIGIN=http://127.0.0.1:5175` (or the exact reviewed preview port). Arbitrary domains cannot be configured as development origins. Keep browser cookie routes and their CSRF protections unchanged.

The initial surface includes GET feed/profiles/profile/notification reads and public offer metadata, feed event collection, and the existing admitted email-code flow. It does not expose a catchall proxy or enable financial/admin actions. Each additional endpoint requires explicit adaptation and acceptance.

## Authentication and links

- Reuse the existing Supabase project, Apple/Google providers, email-code admission hook and account identities.
- App public build values identify the approved hosted website/API origin, Supabase URL and publishable/anon key. No server/service key may enter the app.
- The candidate returns to `https://creatornet-mvp-git-feat-ios-ap-1673c6-nrjimenez2-codes-projects.vercel.app/app/auth/callback?cn_state=<generated-UUID>`. Review a narrowly scoped Supabase redirect allowlist for this host/path and dynamic state. The browser page offers `creatornet://auth/callback` as a manual fallback. No OAuth app, credential, scope, key or consent operation has been recreated here.
- The source now includes an AASA document limited to `/app/auth/callback` for `87Z6A36W7G.com.creatornet.webapp`, plus an entitlement for the exact Preview branch alias. These are prepared source files, not a hosted AASA verification or activation of Associated Domains in the existing Apple identifier. The alias is currently protected by Vercel Authentication, so Apple cannot fetch its AASA until access is reviewed and changed.
- The app verifies callback state and PKCE before establishing a session. Protected deep links still require server authorization. A commerce return never establishes payment or entitlement.

## Native project

Apple Developer account inspection on October 8 verified team `87Z6A36W7G` and the existing explicit CreatorNet identifier `com.creatornet.webapp` (resource `H9WY7JQA8D`). The source bundle identifier now matches in Capacitor and both Xcode configurations. Sign In with Apple was already enabled on the registered primary App ID; Associated Domains and Push Notifications were not enabled. No identifier registration, portal capability, provisioning, signing or device installation has been performed.

The current Mac is Apple silicon (`Mac16,12`) on macOS 15.7.7, with Command Line Tools but no full Xcode. A verified official Node 22.23.3/npm 10.9.9 archive is isolated in `/private/tmp/creatornet-node-v22.23.3` for this worktree; no system-wide Node installation was made. The owner's reported iPhone is on iOS 26.6, and the device/version remains unverified. Software Update offers macOS 27.0.1. Apple lists Xcode 27 on macOS Tahoe 26.6 or later with device support including iOS 26.6; the installed Xcode must still be verified before direct installation. The Mac OS/Xcode setup and phone pairing remain pending.

The native project is generated with Swift Package Manager. The Swift adapters under `apps/ios/native` are copied into the app target, referenced by its Xcode project, and registered through `CreatorNetViewController` in the storyboard. Keep both copies identical; the parity check verifies this. Keychain operations fail closed; they do not fall back to browser storage. The system-browser plugin opens the default external browser. Compile and validate both on Mac before claiming native functionality.

Prepare APNs device registration/removal and delivery storage/worker changes before requesting database/APNs/configuration approval. Keep APNs credentials server-side; use separate sandbox/production registrations, deduplication and bounded retries. Delivery failure must not roll back a notification/payment event. Preserve the existing inbox.

## Mandatory later approval scopes

Concrete hosted migrations, credential/capability changes, provider consent, hosted acceptance operations, deployments/releases and any financial fixture action need their own recorded scope where required. This implementation authorization does not consume the separate PR264 owner's pending setup/redeploy approvals. Never repeat its one-shot purchase, promos, media upload, migration or provider setup to populate this app.

No App Store Connect upload, TestFlight distribution, review submission, public release or tester distribution is authorized by this goal.
