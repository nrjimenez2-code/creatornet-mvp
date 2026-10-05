import { planMentorshipWebhookCoverage, MENTORSHIP_REQUIRED_PLATFORM_EVENTS, MENTORSHIP_REQUIRED_CONNECT_EVENTS } from "@/lib/mentorshipWebhookEvents";
const expected = { id: "we_fixture", url: "https://www.creatornet.net/api/stripe/webhook", livemode: true, apiVersion: "2025-09-30.clover" };
const snapshot = { id: expected.id, object: "webhook_endpoint", url: expected.url, livemode: true, api_version: expected.apiVersion,
  status: "enabled", enabled_events: ["checkout.session.completed", "checkout.session.expired", "payment_intent.succeeded",
    "payment_intent.payment_failed", "charge.refunded", "invoice.payment_succeeded", "account.updated", "invoice.created",
    "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"] };
test("adds current manual lifecycle and refund coverage without removing existing subscriptions", () => {
  const plan = planMentorshipWebhookCoverage(snapshot, expected);
  expect(plan.missingEvents).toEqual(["charge.updated", "customer.subscription.updated", "customer.subscription.deleted",
    "invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible",
    "charge.succeeded", "payment_intent.processing", "payment_intent.canceled", "payment_intent.requires_action",
    "refund.created", "refund.updated", "refund.failed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"]);
  expect(plan.proposedEnabledEvents).toEqual([...snapshot.enabled_events, ...plan.missingEvents]);
  expect(new Set(plan.proposedEnabledEvents).size).toBe(plan.proposedEnabledEvents.length);
  expect(snapshot.enabled_events).toHaveLength(11);
});
test("Connect account updates remain a separate destination requirement", () => {
  expect(MENTORSHIP_REQUIRED_CONNECT_EVENTS).toEqual(["account.updated"]);
  expect(MENTORSHIP_REQUIRED_PLATFORM_EVENTS).not.toContain("account.updated");
  const plan = planMentorshipWebhookCoverage({...snapshot,enabled_events:["checkout.session.completed"]},expected);
  expect(plan.proposedEnabledEvents).not.toContain("account.updated");
});
test("retains unrelated existing events and does not duplicate enabled required events", () => {
  const plan = planMentorshipWebhookCoverage({ ...snapshot, enabled_events: [...MENTORSHIP_REQUIRED_PLATFORM_EVENTS, "customer.created"] }, expected);
  expect(plan.missingEvents).toEqual([]); expect(plan.proposedEnabledEvents).toContain("customer.created");
});
test.each([{ id: "we_other" }, { url: "https://other.example/api/stripe/webhook" }, { livemode: false },
  { api_version: "2026-01-01.other" }, { status: "disabled" }, { enabled_events: ["*"] },
  { enabled_events: ["invoice.created", "invoice.created"] }])("configuration drift %p requires review", changed => {
  expect(() => planMentorshipWebhookCoverage({ ...snapshot, ...changed }, expected)).toThrow("requires review");
});
