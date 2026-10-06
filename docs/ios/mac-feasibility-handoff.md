# Mac and physical iPhone feasibility gate

This is the first native feasibility gate for the complete app goal. It is not full app acceptance, a submission candidate, or permission to distribute. Complete parity remains required after this gate. Preserve the premium and mobile playback chats' ownership and original receipts.

## Source and tools

Use the exact reviewed commit on `feat/ios-app-20261006` from `nrjimenez2-code/creatornet-mvp`. Record the full commit SHA in every build/device result. Preserve any existing dirty Mac checkout; clone into a new empty directory when needed. Do not copy Windows `node_modules`, `.next`, `dist`, generated native public assets, credentials, signing keys or `.env` files.

Capacitor 8 requires Xcode 26.0 or newer and supports iOS 15 or newer. This project uses Swift Package Manager, so open `apps/ios/ios/App/App.xcodeproj`. The generated project already includes the Keychain/system-browser plugins and the active scene's custom bridge. Do not run `cap add ios` again or regenerate the Xcode project. [Capacitor iOS requirements](https://capacitorjs.com/docs/ios)

Use Node 22.22 or newer in the Node 22 line. At the repository root, inspect source before installing:

```sh
git branch --show-current
git rev-parse HEAD
git status --short
node --version
xcodebuild -version
npm ci --no-audit --no-fund
npm run ios:typecheck
npm run ios:parity
```

## First native compilation

An unsigned compile can use the documented fake public configuration. It proves Swift/Xcode integration only. It cannot prove hosted sign-in or playback.

```sh
export VITE_CREATORNET_API_ORIGIN=https://example.invalid
export VITE_SUPABASE_URL=https://example.invalid
export VITE_SUPABASE_PUBLISHABLE_KEY=ci-not-a-real-key
npm run ios:build
npm run ios:sync
xcodebuild -project apps/ios/ios/App/App.xcodeproj \
  -scheme App -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath .test-cache/ios-derived-data CODE_SIGNING_ALLOWED=NO build
```

Retain the compiler exit status and useful diagnostics. Confirm that `CreatorNetSecureStoragePlugin`, `CreatorNetSystemBrowserPlugin`, and `CreatorNetViewController` compile, and that `SceneDelegate` instantiates the custom view controller. Fix native failures on this same app branch, preserving other work.

## Inputs required before hosted/device acceptance

- The owner's actual Apple team and existing bundle identifier. `net.creatornet.ios` is still a draft identifier. No Apple identifier or capability has been registered.
- An explicitly reviewed backend/Preview revision with `CREATORNET_IOS_API_ENABLED=true`, using existing Supabase accounts and services. Record deployment ID, URL and exact SHA. Production configuration/release is separately scoped.
- The matching public `VITE_CREATORNET_API_ORIGIN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`, supplied locally through the process environment. Never include service keys or APNs/OAuth secrets in the app.
- Reviewed Supabase redirect allowlisting for the exact `/app/auth/callback` URI with pending `cn_state`, plus the custom-scheme fallback as applicable. Reuse existing Apple/Google providers; do not recreate credentials or consent.
- A reviewed AASA document and associated-domain entitlement for the actual team/bundle and supported routes. Without these, manual custom-scheme fallback can be investigated, but universal-link/cold-launch acceptance remains pending.
- The owner's paired physical iPhone, its iOS version and Developer Mode/signing setup. Install/run directly from Xcode on this owner's device. Do not upload to App Store Connect or TestFlight or distribute to testers.

Resolve these inputs through `configuration-review.md`; no settings have been applied by the Windows work. Do not use another chat's setup/redeployment approvals for this app.

After the inputs are reviewed, replace the three fake public values, rebuild and sync. Verify that the native `capacitor.config.json` contains packaged `webDir: dist` behavior and no `server.url`, unrestricted navigation, cleartext override, service key or source map. Select the existing team/identifier in Xcode, then build/run on the owner's phone. Record any local signing/project changes.

## Required prototype scenarios

| Area | Acceptance and evidence |
| --- | --- |
| Auth | Existing Apple, Google and admitted email-code login; correct account and onboarding path; expired/incorrect code, resend limit, browser cancellation, expired callback, duplicate callback, warm/cold launch and sign-out. No extra account/provider identities. |
| Secure session | Relaunch restores the intended account through Keychain; native storage failure fails closed; no localStorage/Preferences fallback; no tokens in URLs, logs or screenshots. Refresh and logout behavior remain coherent after backgrounding. |
| Native APIs | Missing/invalid token, deleted/banned account, wrong origin, wrong account/ownership and stale account responses fail closed. Website cookie routes retain their existing CSRF/origin behavior. |
| Feed/profile | Anonymous Discover and authenticated Discover/Following, actual profile read, profile navigation/back, stable scroll and correct user/creator identity. Record unavailable ancillary actions as required parity work. |
| Playback | Cold entry, repeated/rapid/reverse swipes, one active player, sound grant, pause/resume, mute, scrub, loop/end, HLS/MP4, failed media/retry, profile return, background/foreground and Wi-Fi/cellular/constrained network. Preserve the existing five-second/recent-return rules and user pause preference. |
| Interface | Safe areas, keyboard, narrow phone, text scaling, VoiceOver labels/focus, reduced motion and stable tab/back navigation. |

Use the actual main renderer first. Do not silently replace it with the separately owned HLS experiment. Reuse `docs/mobile-feed-phone-acceptance.md` and `docs/mobile-feed-safari-acceptance.md` for the branch's playback contract and recording discipline; their Safari/Instagram experiment status does not constitute WKWebView acceptance. Keep device/surface cohorts separate.

For every scenario, record candidate SHA, app version/build, backend deployment/SHA, device/iOS, network/power conditions, pass/fail, recording reference and concrete failure. Preserve failures, cancellations and missing outcomes. A simulator or desktop renderer fixture cannot pass this gate.

## Stop and resume conditions

If existing WKWebView playback is viable, retain it and continue the full parity matrix: creator publishing/recovery, Library/private delivery and Files sharing, every browser commerce/provider journey and account-bound return, push/APNs, reporting/blocking/deletion, admin controls and submission/release materials. Do not count an unavailable endpoint or compiled shared screen as accepted.

If a scenario fails, retain exact evidence and fix it before broad porting. A major native playback rewrite needs concrete failure evidence and a bounded plan.

The final goal later requires accepted evidence for all 60 currently recorded requirements, passing CI on the final source, and a signed Release archive matching that source/public configuration. Stop before App Store Connect upload, TestFlight, tester distribution, review submission or public release.
