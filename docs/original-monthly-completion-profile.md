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
