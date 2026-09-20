# Email code guard: draft, not ready for production

This change requires coordinated application, email service, database, and Auth hook configuration. Do not merge or enable the hook until the hosted acceptance checks below pass. No provider configuration is changed by the migration.

## Behavior

- The application generates a cryptographically random six-digit code and sends a plain-text code-only email through Resend. Codes expire after 10 minutes and are consumed atomically on acceptance.
- A private database record stores an email digest and a keyed code digest, never a plaintext code. The HMAC uses the existing server service-role credential with a purpose-specific prefix; rotation invalidates outstanding codes. Browser roles cannot read or change these records.
- Five attempts per normalized email within 15 minutes trigger a 15-minute lockout. Correct fifth attempts are accepted. Resends wait 60 seconds and do not reset failed attempts. All tabs, IP addresses, and server instances share the account counter.
- A separate persistent IP counter permits 30 combined send/verify requests per five-minute fixed window before any account row or email is created. This supplements Supabase's native limits. Old idle counter rows are removed in bounded batches after 24 hours.
- Only after the application code passes does the server use Supabase admin `generateLink` and consume its internal token. No link or native provider code is emailed or returned to the browser. `generateLink` supports creating new users as well as signing in existing users.
- A Custom Access Token hook requires an unguessable single-use server User-Agent bound to the admitted email and Auth-created session. Native public email OTP/link requests cannot mint sessions through the hook. OAuth and refresh grants pass through unchanged.

The independent application code is essential: a session hook alone runs AFTER native OTP verification. A caller could otherwise distinguish an invalid OTP from a correct OTP rejected by the hook, then submit that discovered code to the application. Application code hashes are checked before calling Auth, and are unrelated to native OTPs.

## Required configuration

- `RESEND_API_KEY`: a server-only sending key for the verified CreatorNet sender domain.
- `EMAIL_CODE_FROM`: that verified sender, including display name if desired.
- The existing `SUPABASE_SERVICE_ROLE_KEY` is reused when it is a modern `sb_secret_` key. Only if it is a legacy JWT, supply `SUPABASE_AUTH_SECRET_KEY` with a modern server key for the SAME project as `NEXT_PUBLIC_SUPABASE_URL`. Never a browser environment variable; do not rotate or duplicate existing keys just for this change.
- Supabase Auth IP forwarding enabled, preserving the visitor IP from Vercel's overwritten `x-vercel-forwarded-for` header via `Sb-Forwarded-For`. Legacy service-role/anon keys do not support this forwarding. This route fails closed outside Vercel or without a valid platform IP.
- Apply `20260920230602_email_code_attempt_guard.sql` to the selected test project, and later the verified production project.
- Configure the project's Custom Access Token hook as `public.creatornet_email_code_token_hook`. Preserve any existing hook by integrating its behavior rather than replacing it blindly.

Sources: [Supabase forwarding requirements](https://supabase.com/docs/guides/auth/rate-limits), [Vercel trusted headers](https://vercel.com/docs/headers/request-headers), [admin generation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink), [token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook).

## Required hosted acceptance checks

Use an isolated non-production Auth project and a branch-specific Vercel preview. Do not reuse a shared capacity-testing project's hooks or global Auth settings without coordinating its use.

1. Confirm a new-user code creates the account only after valid verification; confirm existing-user login, profile/onboarding routing, cookie sync, refresh, and sign-out.
2. Verify actual hook input grant names, Auth transaction visibility, nonce User-Agent preservation through the gateway, session binding, and hook grants under `supabase_auth_admin`. Local database tests cannot prove these hosted behaviors.
3. Verify five wrong codes lock out the sixth, including across tabs, IPs, and page reloads; resending cannot reset this counter. Verify expiry, replay rejection, valid fifth attempt, and cooldown expiry. Use disposable test accounts, not customer accounts.
4. Try a valid native OTP through the public endpoint: no session may be issued. Learning a native OTP must not make it acceptable to the application endpoint. Do not log native tokens, application codes, or session tokens.
5. Verify Google/Apple and existing token refresh; verify actual production-used grant types are covered. The hook also blocks unadmitted invite/recovery/email-change and phone OTP grants. Those flows are not currently exposed by the email-only UI; do not enable any of them without a compatible, explicitly tested flow.
6. Verify Resend API errors, timeouts, database outages, disabled/misconfigured hook, duplicate submissions, and provider failures all fail closed. Code delivery failure still incurs the send cooldown. An ambiguous accepted-code failure consumes the code; request another after the cooldown.
7. Check gateway rate limits are attributed to the visitor rather than the server. Test the 30-request app IP window with synthetic traffic in the isolated project only.
8. Native `/otp` requests can still send a provider-generated email subject to native send limits, but those codes are not app codes and cannot sign in. Assess confusing legacy email delivery and ensure the UI consistently uses the new sender route.

## Activation and rollback

After hosted acceptance, stage the production configuration and migration, coordinate hook activation with deployment of the updated sign-in UI, and verify deployed SHA and provider settings. There is no automatic atomic transaction across the app deployment and Auth configuration; avoid claiming a zero-interruption rollout. Existing refresh sessions should remain valid, but new email login can be temporarily unavailable if the hook and app are out of sync.

Rollback requires coordinated restoration of the previous UI and hook configuration. Removing the hook restores the previous native IP-only verification protection; it must be an explicit rollback decision. Never delete users or auth sessions to roll back this feature.

Only after deployment and acceptance should the user receive the final fresh code and enter it themselves on CreatorNet. Confirm delivery separately from mail-server acceptance. The earlier code-only Supabase template change does not establish that this stronger guard is live.
