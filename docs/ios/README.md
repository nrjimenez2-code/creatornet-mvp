# CreatorNet iPhone app

The goal is complete website feature parity for every role, a signed release build, physical-iPhone acceptance, and prepared US App Store submission materials. This branch must stop before upload, TestFlight, review submission, public release, or distribution to testers.

## Verified starting point

- App branch: `feat/ios-app-20261006`.
- Website baseline: main `9abccd86dc16611bb0046cef439d09f3a5e85329`.
- Production deployment observed October 6, 2026: `dpl_nkLwdsNWx5Qs3VjrcDve5ftoWZke`, READY, the same Git SHA, assigned to `www.creatornet.net` and `creatornet.net`.
- Premium work remains separately owned: PR #264, `9c55b9f43b37c94b18228e5646c09ebb14c02b0c`. Its October 5 handoff and retained purchase/upload/provider/migration receipts remain dependencies. A later Ready Preview was observed; that alone does not establish acceptance or release.
- Current app work is an intermediate client/transport candidate. Full parity and device acceptance are unfinished.

## Architecture

`apps/ios` contains a Vite React/TypeScript client, React Router, Capacitor configuration and native adapters. Its interface is built into `dist` and packaged locally. The config has no `server.url`, remote live reload or unrestricted navigation.

The Next.js website and server APIs remain hosted. The app reuses the actual feed renderer, playback behavior, profile components, search, profile editor and onboarding. Next-specific client routing/image/lazy-loading imports resolve through explicit app adapters. Server-only modules are rejected by the Vite build. `packages/shared` holds website media routing and bio validation with website compatibility exports.

The current mobile website is the visual reference. Discover uses the website's dashboard page; authenticated navigation uses its existing Discover / Following / create / Library / Profile bar. Sign-in renders `components/AuthView.tsx` in both clients with platform-specific authentication actions. Profiles retain the website's centered avatar/name/bio/stats layout and shared mobile header, posts/offers and sharing controls. These shared screens still require native behavior and physical-device acceptance.

Shared client modules use `lib/apiFetch`; the default still calls the website's same-origin `fetch`. Only the app installs the explicit hosted transport. It drops caller-supplied cookies/authentication, adds the current app bearer token, rejects redirects, and does not automatically retry writes. Responses from a switched account are discarded.

`/api/mobile/*` is a separate allowlisted surface and defaults to disabled. The boundary checks the exact packaged origin (or explicitly configured loopback development origin), verified Supabase user and current account ban/existence, request method, request size and rate limit. It strips browser cookies and response `Set-Cookie` headers. No authorization header alone bypasses these guards. Existing browser CSRF/origin checks remain in place.

Native Supabase sessions and PKCE verifiers use a local Keychain plugin with device-only storage. Browser feasibility checks use memory. There is no native fallback to localStorage or Capacitor Preferences. OAuth uses PKCE, a persisted pending-state check, known callback routes, expiry and cancellation handling. Access/refresh tokens are never placed in callback/browser URLs or logs.

## Local setup and checks

Use Node 22.22 or newer in the Node 22 line, or another supported current Node version. The installed Windows Node 22.21 emits an engine warning for the existing `posthog-node@5.50.0`; it was not globally replaced.

From the repository root:

```text
npm ci --no-audit --no-fund
npm run ios:typecheck
npm run ios:parity
npm test -- --runInBand --runTestsByPath <affected.test.ts>
npm run ios:build
npx tsc --noEmit
npm run build
```

The app build/dev server requires three public settings: `VITE_CREATORNET_API_ORIGIN`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Supply values through the process environment; do not transfer credentials or dependency folders between computers. Build checks use `https://example.invalid` and `ci-not-a-real-key`. Such a build is a compilation fixture, not an installable acceptance/release candidate.

`npm run ios:dev` uses loopback port 5175; `npm run preview --workspace @creatornet/ios` uses 5176. Preserve other servers and avoid parallel writes to this app's `dist` or the website's `.next`.

Repository CI retains its selector safeguards, full-suite fallback, media-worker tests and website build. It now also typechecks/builds the app and validates parity scope. A green build proves compilation and fixtures; physical-iPhone and hosted acceptance remain separate.

## Scope and readiness records

`feature-parity.json` includes every current website page, the premium branch's extra route, and cross-route requirements for publishing/upload recovery, every commerce journey, native push, media/Files, account controls, playback and release materials. Every row retains its implementation/dependency/evidence state. `node scripts/ios-parity.cjs --ready` must fail until every required item is accepted with candidate revision/build/device evidence.

Do not treat an unavailable native endpoint, a shared component that compiles, a browser fixture, or a simulator as accepted app behavior. In particular, commerce, notification writes, creator management, administrative tools, native push, account deletion/blocking, downloads/uploads and many page adaptations remain required work.

Only new managed offline playback, background audio, background upload continuation, a dedicated Mac app and an iPad redesign are deferred.
