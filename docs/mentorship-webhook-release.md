# Mentorship webhook release candidate

The live platform endpoint was re-read in this task. It remains enabled at
`https://www.creatornet.net/api/stripe/webhook`, endpoint
`we_1U7MxjAPff7wDYc9b3W6fcw8`, account `acct_1SGnG1APff7wDYc9`,
API version `2025-09-30.clover`, with eleven event subscriptions.

The additive proposal requires seven more events:

- `charge.updated`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `invoice.voided`
- `invoice.marked_uncollectible`

`lib/mentorshipWebhookEvents.ts` holds the minimum eighteen-event platform
coverage and generates an additive plan from a freshly retrieved endpoint. It
refuses endpoint/mode/URL/API-version drift, disabled endpoints, duplicate lists
or wildcard subscriptions requiring a separate review. Existing unrelated
subscriptions are retained. It performs no provider writes.

The real HTTP webhook verifies Stripe signatures and acquires the durable event
claim before the monthly handoff. The new local integration tests exercise all
seven events using both the current endpoint API version and the monthly runtime
version. Dedicated runtime reconciliation is represented by synthetic ports.
Failures return 500 and release the claim without completing it; completed
duplicates do not re-enter reconciliation. No legacy payment path is invoked for
owned monthly events. These tests do not prove Stripe delivery, actual database
claim durability, or provider accounting and recovery.

Before applying the proposal, complete the corresponding staged signed-delivery
and payment lifecycle acceptance and verify the intended release deployment and
feature gates. Re-read the live endpoint and compare its entire observed event
list, identity, mode, enabled status, URL and API version with the proposal.
If any value changed, recompute and review the delta. Apply only `enabled_events`,
retaining existing events; do not change the signing secret, URL or API version.
Read back and verify the result. The separate Connect endpoint has no proposed
change. Production configuration remains unchanged during this implementation.
