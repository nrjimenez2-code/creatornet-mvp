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

The prepared `.github/workflows/ios-native.yml` runs this unsigned device-target compile on GitHub's standard `macos-26` runner using Xcode 26.6 and the same fake app values. It records the actual tested Git SHA, Node/Xcode versions, SDK list and compiler log. Its artifact contains only text metadata/logs, with no app binary, archive, export, signing identity or credential. Check the exact workflow revision/result before reusing its native compilation evidence. The owner still needs a Mac/physical phone for signing, installing and the scenarios below; CI does not satisfy those gates. [GitHub runner tools](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)

## Inputs required before hosted/device acceptance

- Apple team `87Z6A36W7G` and registered bundle identifier `com.creatornet.webapp` were verified October 8. Candidate source matches; the owner-approved Associated Domains portal capability, development provisioning, signing and direct installation completed.
- An explicitly reviewed backend/Preview revision with `CREATORNET_IOS_API_ENABLED=true`, using existing Supabase accounts and services. Record deployment ID, URL and exact SHA. Production configuration/release is separately scoped.
- The matching public `VITE_CREATORNET_API_ORIGIN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`, supplied locally through the process environment. Never include service keys or APNs/OAuth secrets in the app.
- Reviewed Supabase redirect allowlisting for the exact `/app/auth/callback` URI with pending `cn_state`, plus the custom-scheme fallback as applicable. After the initial disabled-provider failures, the owner approved separate Staging-only Apple/Google setup. Both now show enabled in Staging Supabase; Apple sign-in and cold-launch persistence were reported successful on the owner phone. Google OAuth completed but mobile profile validation initially failed with a 503 from an oversized likes lookup. After the hosted fix, the owner reported a signed-in Google profile on retry; a fresh Google OAuth run and cold launch remain unverified. Preserve existing Production and Google Calendar credentials.
- The candidate includes AASA and an associated-domain entitlement limited to the exact Preview branch alias and `/app/auth/callback`. Apple portal capability and unauthenticated hosted accessibility/response headers are verified. Apple's CDN returned HTTP 200 and the expected callback-only document during the second temporary public window on October 9 UTC. The owner used the hosted Open CreatorNet fallback for Apple and Google; automatic universal-link return remains unverified.
- This Mac now runs macOS 27.0.1 with Xcode 27.0 (build `27A266a`). The owner accepted Xcode's license; `xcodebuild -checkFirstLaunchStatus` passed and `xcrun` resolved the iPhoneOS 27.0 SDK. CoreDevice verified the owner's iPhone 17 Pro Max (`Noah`) on iOS 26.6 (build `23G71`), connected by wired USB and paired. Developer Mode is enabled, Xcode lists the device as connected without a missing developer disk image, and the phone is unlocked. The owner separately approved and Xcode completed development signing and direct installation on this phone. Do not upload to App Store Connect or TestFlight or distribute to testers.
- The October 8 local `npm run ios:build`, `npm run ios:sync`, and unsigned generic iPhoneOS Debug compilation passed under Xcode 27.0 with fake public CI values. This establishes local native compilation, not hosted configuration or physical acceptance.
- The same build/sync/unsigned-compile sequence passed again using the actual public iOS branch Preview origin and CreatorNet Staging Supabase publishable key. The candidate bundle is `com.creatornet.webapp`, version `1.0` build `1`. Xcode automatic development signing, device registration, direct installation, and launch succeeded after separate owner approval.

Resolve remaining inputs through `configuration-review.md`. The owner approved the scoped Staging Preview setup on October 8; its Vercel branch-only mobile API flag, Apple Associated Domains capability, and narrow Supabase Staging redirect are saved. The exact iOS branch redeployment `dpl_31Kb7ULdQtmBwN6n4ffUT7fThqK1` is READY. The exact temporary public exception for only the iOS branch alias was used for the short phone gate and then removed; an unauthenticated request again redirects to Vercel SSO. Public AASA and basic API boundary checks passed during the exception. The physical phone rendered the synthetic Staging feed, and the owner reported media playback, creator profile navigation, and successful email sign-in return. Full auth/profile/playback acceptance remains pending. Do not use another chat's setup/redeployment approvals for this app.

A second exact-alias exception window was owner-approved for Apple/Google auth checks and removed afterward. Both providers returned Staging Supabase HTTP 400 `validation_failed`, `Unsupported provider: provider is not enabled`, before account selection or app return. The phone showed the signed-in QA buyer profile before an explicit process relaunch; the owner's qualified report after that relaunch supports only partial session-persistence evidence. Resolve provider configuration with a separately reviewed Staging-only scope; preserve the disabled result and do not count native OAuth or cold-launch acceptance yet.

After separate owner approval, Staging-only Apple and Google OAuth credentials were configured and both providers were enabled. In a third owner-approved exact-alias public window, Apple sign-in returned to the installed app signed in, and the owner definitively reported persistence after closing and relaunching the app. Google returned to the app but profile validation failed. Vercel logged `/api/mobile/profile/me` HTTP 503; Supabase logged `/rest/v1/likes` HTTP 400 with a 39,078-character query string. The fix batches that lookup into 80-post requests. Focused Jest, TypeScript and ESLint checks passed. It was deployed READY at `f639b7edf3de081395418067b7baac557db64709` as `dpl_9jWehBTUk7VgPmkPf6rB7RBPUboX`. In a fourth owner-approved exact-alias window, the owner tapped Try again on the existing Google error screen and reported a signed-in Google profile. This verifies recovery of the existing session's profile read; a fresh full Google flow and Google cold launch remain unverified. All four temporary exceptions were removed after their gates and the alias is protected again. Resolve app access to a protected Preview backend before submission readiness.

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
