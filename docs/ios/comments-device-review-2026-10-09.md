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

## Physical gate pending

CoreDevice confirmed Noah is paired and connected, running iOS 26.6 on iPhone 17 Pro Max. This new Debug app has not yet been installed or physically accepted. The signed-in Vercel settings page showed Require Log In enabled and only the older Discover alias in the public exception table; no new exception was opened.

After the matching Preview is READY and the owner approves the next scoped phone window, install/launch this candidate and check:

1. Comments covers the whole phone and video rail, with header below the status area and input above the home indicator; typing keeps the input usable.
2. Post one synthetic test comment, then delete that same comment through its options; close/reopen the thread to verify it stays deleted.
3. Toggle Like and verify the icon/count, including after reopening the same post.
4. Share/copy the same post and verify an HTTPS website link rather than `capacitor://localhost`.

Restore the exact iOS Preview protection immediately after the gate and record only measured results. No full parity item, signed Release, submission readiness, purchase, Production change, App Store upload, or distribution is established here.
