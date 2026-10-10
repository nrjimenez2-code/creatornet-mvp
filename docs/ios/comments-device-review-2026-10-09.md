# Comments phone gate — October 9, 2026

## Observed failure and source candidate

The owner’s four-second recording at `/Users/piperpoole/Library/Messages/Attachments/cb/11/4B5999B6-E680-4F6F-8E05-E842B3B4D1F1/ScreenRecording_10-09-2026 12-40-34_1.mov` showed the Comments header entering the status area and the video action rail remaining exposed beside Comments on the installed `599eac84b20cbea3b2cb4dfecffa09e9c1dd6caf` Debug app. It showed a comment row from the synthetic Staging account, but did not establish Like, comment deletion, or HTTPS Share acceptance. The exact iOS Preview exception was removed after that gate.

The follow-up candidate in `components/CommentPanel.tsx` portals the dialog to `document.body`, uses the full phone width, reserves the top and bottom safe areas, and retains the 400-pixel desktop drawer. The existing lifecycle tests now query the portaled dialog and verify its body-level placement. The video card already ignores portal click events outside its DOM, so dialog interactions do not toggle playback.

The preceding chat ran `npm test -- --runInBand __tests__/feed-comment-lifecycle.test.ts __tests__/ios-mobile-comments.test.ts` on this unchanged patch: 2 suites / 10 tests passed. Native and root TypeScript checks also passed there. Those checks were retained rather than repeated. `git diff --check` passed again during continuation. The previous installed commit’s GitHub CI, unsigned iPhone compile, and schema check were confirmed successful; those runs do not validate this new patch.

## Local package and development signature

`npm run ios:build` and `npm run ios:sync` passed with the previously reviewed public Staging configuration:

- Website/API origin: `https://creatornet-mvp-git-feat-ios-ap-1673c6-nrjimenez2-codes-projects.vercel.app`.
- Supabase URL: `https://nwqfofezfzljhxolkycz.supabase.co`.
- Key type: publishable; SHA-256 of its UTF-8 value: `e1733a1a36d2565fbfec7713ec4faf0ee48bdafe433e0d613655edad9b65dc47`.
- Insights UI enabled; playback collection disabled.

All 54 dist files matched both the synced native `public` folder and the signed Debug `App.app/public` byte-for-byte. SHA-256 of the manifest, formed by sorted POSIX relative paths followed by a space, each file’s SHA-256, and a newline per entry, was `4a386df5d605b41beff834747cb872d77f173991bb8b76228ddb0575d2767646`. Native sync added only `cordova.js` and `cordova_plugins.js`. The package contained the portal and safe-area CSS, with no fake CI origin/key, source maps, secret-shaped Supabase value, or private-key marker found.

Xcode 27.0 built the existing App scheme in Debug for generic iOS with automatic development signing and team `87Z6A36W7G`. `BUILD SUCCEEDED`; the bundle is `com.creatornet.webapp`, version `1.0`, build `1`. The local result is `/private/tmp/creatornet-ios-comments-devicebuild/Build/Products/Debug-iphoneos/App.app`, with compiler log `/private/tmp/creatornet-ios-comments-xcodebuild.log`. Independent `codesign --verify --deep --strict` exited 0 for this bundle. The earlier `CSSMERR_TP_NOT_TRUSTED` result remains historical evidence; no trust settings were changed and its previous cause was not determined.

The untracked Xcode `swiftpm/Package.resolved` was inspected. It pins Capacitor `8.5.2` and ion-ios-filesystem `2.0.0`, matching the resolved native graph. It remains a generated local file and was excluded from the source patch.

## b019385 phone gate: installed, layout failed

The owner approved installation and a public window of up to five minutes for only the exact iOS branch alias. CoreDevice installed `b01938525c56ef9847064eb3f5186faaf29fb083` on Noah (iPhone 17 Pro Max, iOS 26.6) and initially launched it successfully. The later relaunch after opening the exception failed because the phone was locked; the owner unlocked/opened the app manually. During the window, an unauthenticated mobile feed request from `capacitor://localhost` returned HTTP 200 with 20 items.

The exact iOS alias exception was opened at approximately 2026-10-10 03:01:07 UTC. After the owner reported the failure, it was removed; the Vercel table again listed only the older Discover exception. An unauthenticated mobile-feed request returned HTTP 302 at 03:05:17 UTC, confirming protection was restored within the approved five minutes. Production and the older exception were not changed.

The owner supplied a 30.035-second recording at `/Users/piperpoole/Library/Messages/Attachments/fc/12/909AC0E9-B36B-4F3E-A68C-F4F007C1F2F6/ScreenRecording_10-09-2026 20-02-24_1.mov`. Frame inspection establishes:

- Comments initially covers the phone and reserves the status/home areas.
- At about 4 seconds, focusing the composer enlarges/pans the entire view. The avatar and Send button are clipped and the header/rows move above the visible area while the keyboard is open.
- At about 8 seconds, the new synthetic `comment` appears with a `now` timestamp. Posting worked in this recording, but comment deletion/persistence was not demonstrated.
- After keyboard dismissal, Comments remains enlarged and horizontally clipped. Closing it leaves the underlying video enlarged too.
- Like icon/count changes are visible; persistence after reopening the same post is not established.
- The owner supplied the copied link `https://creatornet-mvp-git-feat-ios-ap-1673c6-nrjimenez2-codes-projects.vercel.app/dashboard?postId=bfd44bba-2f17-470e-a3c5-8c149d42c238`, confirming HTTPS copy format for this post. Opening/playback of that link is not established.

No full parity item is accepted from this gate.

## Keyboard layout follow-up candidate

The shared composer and edit field previously used `text-sm` (14px). The zoom seen immediately on composer focus is consistent with iPhone focus zoom at that size. Both fields now use 16px `text-base`, and the composer can shrink within its flex row. Header/form controls do not shrink, and long author names can wrap without displacing their options.

While Comments is open, its body-level dialog follows the visual viewport's width, height and offsets on resize/scroll, keeping its header, scrollable rows and composer in the visible keyboard area. The underlying body is scroll-locked and its prior inline overflow is restored on close/unmount. Deliberate pinch zoom keeps the browser's normal fixed layout; zoom is not disabled. This uses the visual/layout viewport distinction documented in the [CSSOM View specification](https://www.w3.org/TR/cssom-view-1/#visual-viewport). It requires physical WebKit retesting and does not itself establish visual acceptance.

Local checks passed after this follow-up:

- Focused Comments lifecycle/mobile suites: 2 suites / 12 tests, including keyboard resize/pan/dismissal, listener cleanup, preservation of the parent scroll lock, and deliberate zoom behavior.
- Root TypeScript (`--noEmit --incremental false`) and native TypeScript checks.
- Staging Vite build and Capacitor sync with the same reviewed public configuration above.
- Xcode Debug development-signing build and independent `codesign --verify --deep --strict`.

All 54 dist assets match the synced native project and new signed app byte-for-byte. Manifest SHA-256 is `149341753d06818ca935ad5c2e40f8c0f876196b626fc3be38e22b8a966f491a`, using the algorithm described above. The package contains the visual-viewport handler, 16px input rule, minimum-width rule and safe-area rules. Reviewed public API/Supabase values are present; no fake CI origin, source maps, secret-shaped key value or private-key material was found. The literal `sb_secret_` validation prefix in library/config guards is not a packaged secret value.

New local signed Debug app: `/private/tmp/creatornet-ios-comments-keyboard-devicebuild/Build/Products/Debug-iphoneos/App.app`. Build log: `/private/tmp/creatornet-ios-comments-keyboard-xcodebuild.log`. Asset verification: `/private/tmp/creatornet-comments-keyboard-package-verification.json`. It has not yet been installed or physically accepted. The generated SwiftPM file remains excluded from the source commit.

After matching CI and Preview are ready, the next owner-approved phone window must retest focus/type/post, keyboard dismissal and Comments close/reopen without zoom or clipping; delete only the same synthetic test comment and verify its absence after reopening. Like persistence and opening the HTTPS Share link remain pending. Restore the exact iOS Preview protection immediately afterward.

The parity matrix still records 49 website pages, 60 required items and 0 accepted. Signed Release, role-specific parity, submission readiness, purchase flows, App Store upload and distribution remain unestablished. Stop before App Store Connect upload, TestFlight, tester distribution, review submission or public release.
