# CreatorNet authentication launch runbook

This runbook records the two redirect layers used by CreatorNet's Supabase-hosted
Sign in with Apple flow. It intentionally contains no private key or client
secret.

## Redirect configuration

### Apple Developer Services ID

- Services ID: `com.creatornet.web`
- Associated App/Bundle ID: `com.creatornet.webapp`
- Domain: `rvkqxgghqitkwzdsuclz.supabase.co`
- Return URL: `https://rvkqxgghqitkwzdsuclz.supabase.co/auth/v1/callback`

Apple returns to Supabase at this URL. This is not the application's final
post-authentication destination.

### Production Supabase Auth URL configuration

- Site URL: `https://www.creatornet.net`
- Allowed redirect URL: `https://www.creatornet.net/auth`

Supabase sends the authenticated browser to this application route. The same
destination is used for Apple, Google, and passwordless email.

## Apple credential rotation

The Apple OAuth client secret must be rotated at least every six months. Keep
the signing key outside Git, application source, frontend environment
variables, logs, and chat.

When a signing key must be replaced:

1. Create the replacement key without revoking the active key.
2. Generate a new Apple OAuth client secret from the replacement key.
3. Update the Supabase Apple provider through a secure channel.
4. Test first-time and returning-user Apple authentication.
5. Revoke the old key only after the replacement is verified.
6. Record the new client-secret expiration date and schedule the next rotation.

## Acceptance tests

Run these tests after any redirect or Apple credential change:

1. Register a new Apple user and finish onboarding.
2. Sign out, then sign the same Apple user back in to the dashboard.
3. Refresh the destination and confirm the session remains active.
4. Test Google sign-in to the same destination.
5. Request a passwordless email code from an external address and complete it.
6. Confirm none of the three methods returns a signed-in user to the public
   landing page or enters a redirect loop.

## Email authentication model

CreatorNet uses passwordless six-digit email codes. Users do not create a
password, so there is no password-reset surface. Apple and Google remain the
primary social options, and email codes provide the provider-independent
fallback.

### Per-environment email configuration

The app validates exactly six digits. In the intended Supabase project, verify
**Authentication > Sign In / Providers > Email > Email OTP length** is **6**.
Do not assume a new staging project's default matches production. An eight-digit
provider code cannot pass the current six-digit form. Preserve the approved
expiration, email confirmation, and rate-limit settings when correcting a
configuration mismatch; obtain approval before changing authentication settings.

Both **Confirm sign up** and **Magic link or OTP** must include `{{ .Token }}`.
Reuse `docs/email-templates/login-code.html` and inspect the rendered preview to
ensure replacing a template did not append it to the old content. Use a clearly
identified staging sender and subject for staging emails. Keep staging SMTP
credentials separate from production and out of Git, logs, and handoff records.

A successful code request only confirms acceptance of the request. Record the
provider's delivery result, actual inbox or spam placement, code verification,
onboarding/dashboard destination, and refresh persistence for both new and
returning users. If the provider reports a bounce, preserve the exact diagnostic
without guessing its cause or repeatedly resending. Never use a code or link from
the sender dashboard as a substitute for recipient-mailbox acceptance evidence.
