# Remembered sound

New visitors prefer sound. The initial server render stays muted for hydration;
the client waits for auth resolution, loads an account choice if necessary, and
attempts sound on the active feed video. A browser autoplay refusal stays local
to the player and never becomes a saved mute preference.

Both the mute button and “Tap for sound” unmute and call `play()` directly in the
click handler. A rejected attempt restores muted playback and the prompt. Only
the active feed card should produce audio. A deliberate mute remains respected.

Guests retain the existing `cn-sound-on` localStorage boolean. Signed-in accounts
use a separate `cn-sound-on:<userId>` record with a revision and pending-save flag.
The account value lives in Supabase Auth user metadata as `cn_sound_on` (boolean),
and is not used for authorization. No database migration is required.

The app root performs account sync, not each video. It reads the current Auth
user on sign-in/page load/token refresh and reconnect. Button changes take effect
locally before the network save. Writes are serialized; failed writes remain
pending and retry on another choice, reconnect, or later login. A delayed read
cannot replace a newer local choice. Requests retain the owning session's access
token so an account switch cannot redirect an old save to another user. Existing
account values take precedence over the old browser preference; legacy preferences
migrate only when no account value exists. Guest state remains separate on logout.

Account sync is eventual, not live cross-device broadcasting. A different device
loads the choice on its next account sync. Browser storage restrictions can limit
offline persistence to the open page. Browser permission to play audible media
is separate from the remembered preference and can still require another tap.

## Acceptance before production

Automated regression tests simulate autoplay refusal and user gestures; they do
not establish real Safari/Android autoplay behavior. Check on actual iPhone Safari,
Android Chrome, and desktop browsers:

- Fresh visit: attempt sound; if blocked, keep video moving with a sound prompt.
- One sound tap: audible playback starts, including from a paused video.
- Scroll through several videos, navigate away/back, reload, and reopen the browser.
- Deliberately mute: retain mute across navigation/reload and on another signed-in device.
- Unmute again: retain sound as the preference; show a prompt only after real refusal.
- Change sound offline, reconnect, and verify the account value on another device.
- Switch accounts on the same browser; verify separate preferences and guest state.
- Watch-page native controls and feed controls agree on the saved preference.

No application can permanently override the browser's autoplay policy. Reusing
one media element across feed cards is a separate architectural change to consider
only if actual device testing identifies repeated per-video prompts.
