# Hashtag phone gate — October 9, 2026

The first tag candidate was source commit `e410ec5953d3097fa41cec5d82d1193a8c2c2442` on `feat/ios-app-20261006`. The exact iOS Staging Preview alias pointed to READY Vercel deployment `dpl_Aw6ebE4z4oFdPJPVf93zmnCs2gbZ` at the same commit. Its signed Debug app had 54 packaged web assets matching the synced Xcode project and `App.app` byte-for-byte (sorted-content SHA-256 `bbb40029a029d0d692e913c990c5f2317ee3e2889bceeac929f49fcebd1d6d43`). Noah was wired for successful install and launch.

During the owner's approved short exception for only `creatornet-mvp-git-feat-ios-ap-1673c6-nrjimenez2-codes-projects.vercel.app`, the hosted mobile tag endpoint returned HTTP 200 with two posts and `hasMore: true` for `business & entrepreneurship`; a wrong-Origin request returned HTTP 403. On Noah, the owner tapped a visible hashtag in Discover and reported that the hashtag heading, description and tagged video grid loaded. The owner could not tap the Back button because it did not fit the top of the screen, so return navigation and opened-video playback did not pass this gate.

The exact iOS exception was removed immediately after the finding. Vercel showed a protection-restored success message; the exception table again listed only the older Discover alias. No purchase or Production/distribution action occurred.

The follow-up source adds iPhone safe-area offsets and 44-point tap targets to the tag grid Back button and opened-video close button. That fix awaits a new signed physical retest. Hashtag interest-score activity still needs a dedicated mobile route; the website call currently has no native counterpart. The tag route remains candidate-partial, with no accepted parity evidence.
