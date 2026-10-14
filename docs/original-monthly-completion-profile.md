# Original monthly completion profile

The manual `mentorship-sandbox` profile uses a different Stripe TEST account and
origin from the original monthly agreements. Use a separately prepared Preview
configuration for original monthly completion. The root `vercel.json` remains
the manual sandbox configuration; preparing this profile does not change it.

`release-checks/original-monthly-completion.cjs` pins the original monthly TEST
account, API version, Staging project and accepted site origin. Its prepared
configuration closes all other readiness gates, new checkout, payoff admission,
renewal collection, retry and workers. It preserves original signed event
reconciliation, original activation observation, previously captured first/payoff accounting, abandonment
reconciliation, buyer Stop and management. Existing handlers can make original
accounting or containment writes; preparation is not authority to execute them.

Preparation requires exactly two separately reviewed agreement ID/fingerprint
bindings. Real bindings belong in the sealed local deployment package, rather
than in this public source or test fixtures. It generates a separate deployment
configuration with automatic Git deployments and cron schedules disabled.
The prepared runtime `env` and `build.env` share the original completion profile
and closed admission gates. Unrelated build settings are preserved; inherited
build-only readiness gates are closed. The manual sandbox base remains unchanged.

Before deploying, bind the source tree and final configuration digest to the
approved package, prove the required installed schema/ACL compatibility, verify
original webhook credential/delivery ownership, and establish the owner window.
Do not overwrite the accepted account/origin or the distinct manual context pin.
Assignment to the original site alias, configuration changes and hosted handler
execution require their exact separate approval. Nothing authorizes Production.

Each approved build preflight or runtime observation makes exactly three GETs:
Stripe `/v1/account`, Stripe `/v1/balance`, and a Staging PostgREST projection of
the two pinned agreement IDs, fingerprints and accepted payment contexts. These
fresh reads require a new explicit scope; old consumed financial read windows
do not apply. No original subscription, invoice, charge, transfer or payoff is
retrieved or replayed by this checker. Requests have ten-second deadlines and
no retries or redirects. Failures emit only a fixed diagnostic.

The runtime identity endpoint uses the generated deployment host and reports
configuration, original account/mode and two stored context bindings. It does
not establish publishable-key account binding, installed schema, genuine signed
delivery, hosted closure, provider/runtime drain, payment authority or LIVE
acceptance. A configured readiness gate does not establish its hosted proof.

## Optional signed-delivery observation

For an independently approved delivery check, prepare a new configuration with
`prepareConfiguration(base, bindings, { webhookVerificationOnly: true })`. This
sets `CREATOR_ORIGINAL_MONTHLY_WEBHOOK_VERIFY_ONLY=true` in both runtime and
build environments. Default preparation omits the flag and retains the original
completion behavior; inherited observation flags are removed unless selected.
The identity proof reports `configuredWebhookVerificationOnly`, which is a
configuration observation rather than genuine signed-delivery acceptance.

With this flag, both webhook URLs require the closed original Preview profile,
project, Staging URL and generated deployment host. Existing independent
platform/Connect signature, mode and source checks still apply. Accepted events
return a bounded verification receipt before the shared event claim, duplicate
refund repair, reconciliation, fulfillment or connected-account refresh. No
financial object, signature, secret or request URL/query is retained in that
receipt. Delivery can produce ordinary platform logs and sampled telemetry.
Malformed configuration fails closed. Production cannot use observation mode.

Observation mode does not authorize provider destination creation, protection
bypasses, credential entry, delivery/resend, financial operations or deployment.
It does not establish payment/accounting/access acceptance, event drain or full
schema compatibility. Genuine delivery still needs exact provider-side evidence
matched to the deployed receipt. Keep existing destinations and historical
financial operations intact. Normal completion and financial acceptance require
a separately reviewed package without this flag and their own execution scopes;
never silently fall through from observation to payment processing.
