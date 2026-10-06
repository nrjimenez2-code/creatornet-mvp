# Configuration review before hosted/device work

These are prepared configuration requirements, not applied settings or approvals.

## Hosted app API

Choose an authorized backend environment and exact source revision. Set `CREATORNET_IOS_API_ENABLED=true` only for that reviewed environment once its enabled endpoints/security checks pass. For browser development only, optionally set `CREATORNET_IOS_DEV_ORIGIN=http://127.0.0.1:5175` (or the exact reviewed preview port). Arbitrary domains cannot be configured as development origins. Keep browser cookie routes and their CSRF protections unchanged.

The initial surface includes GET feed/profiles/profile/notification reads and public offer metadata, feed event collection, and the existing admitted email-code flow. It does not expose a catchall proxy or enable financial/admin actions. Each additional endpoint requires explicit adaptation and acceptance.

## Authentication and links

- Reuse the existing Supabase project, Apple/Google providers, email-code admission hook and account identities.
- App public build values identify the approved hosted website/API origin, Supabase URL and publishable/anon key. No server/service key may enter the app.
- Prepare the exact authentication return URI `/app/auth/callback` and the `creatornet://auth/callback` fallback. Register them only after reviewing the existing provider/Supabase redirect configuration. No OAuth app, credential, scope, key or consent operation has been recreated here.
- Add a reviewed AASA document for the actual Apple team and existing bundle identifier, constrained to supported app link routes; activate associated domains in the existing app identifier/capabilities. Do not invent a team ID.
- The app verifies callback state and PKCE before establishing a session. Protected deep links still require server authorization. A commerce return never establishes payment or entitlement.

## Native project

`net.creatornet.ios` in Capacitor config is a draft source identifier. Verify the owner's existing Apple app identifier/team before signing or reusing it. No identifier registration/signing/capability action has been performed.

The native project is generated with Swift Package Manager. The Swift adapters under `apps/ios/native` are copied into the app target, referenced by its Xcode project, and registered through `CreatorNetViewController` in the storyboard. Keep both copies identical; the parity check verifies this. Keychain operations fail closed; they do not fall back to browser storage. The system-browser plugin opens the default external browser. Compile and validate both on Mac before claiming native functionality.

Prepare APNs device registration/removal and delivery storage/worker changes before requesting database/APNs/configuration approval. Keep APNs credentials server-side; use separate sandbox/production registrations, deduplication and bounded retries. Delivery failure must not roll back a notification/payment event. Preserve the existing inbox.

## Mandatory later approval scopes

Concrete hosted migrations, credential/capability changes, provider consent, hosted acceptance operations, deployments/releases and any financial fixture action need their own recorded scope where required. This implementation authorization does not consume the separate PR264 owner's pending setup/redeploy approvals. Never repeat its one-shot purchase, promos, media upload, migration or provider setup to populate this app.

No App Store Connect upload, TestFlight distribution, review submission, public release or tester distribution is authorized by this goal.
