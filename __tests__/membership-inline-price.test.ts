import { assertMembershipHeld } from "@/lib/membershipCheckout";
import { assertMembershipActivated } from "@/lib/membershipRenewal";
import { membershipFixture } from "../test-support/membership-fixtures";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";

test.each([false, true])("inline price active=%s preserves bootstrap and activated subscription validation", active => {
  const f = membershipFixture(), r = membershipRenewalFixture();
  f.subscription.items.data[0].price.active = active;
  r.subscription.items.data[0].price.active = active;
  expect(() => assertMembershipHeld(f.subscription, f.a, f.customer.id, f.product.id, true)).not.toThrow();
  expect(() => assertMembershipActivated(r.subscription, r.a, r.product.id, r.proof)).not.toThrow();
});

test.each(["amount", "currency", "product", "interval", "interval_count", "usage", "mode", "quantity", "metadata", "destination", "discount", "hold", "invalid_active"])(
  "archived inline price does not weaken the %s guard", fault => {
    for (const phase of ["bootstrap", "activated"]) {
      const f = phase === "bootstrap" ? membershipFixture() : membershipRenewalFixture();
      const s = f.subscription, price = s.items.data[0].price;
      price.active = false;
      if (fault === "amount") price.unit_amount = 50;
      if (fault === "currency") price.currency = "eur";
      if (fault === "product") price.product = "prod_other";
      if (fault === "interval") price.recurring!.interval = "year";
      if (fault === "interval_count") price.recurring!.interval_count = 2;
      if (fault === "usage") price.recurring!.usage_type = "metered";
      if (fault === "mode") price.livemode = true;
      if (fault === "quantity") s.items.data[0].quantity = 2;
      if (fault === "metadata") s.metadata = {};
      if (fault === "destination") s.transfer_data!.destination = "acct_other";
      if (fault === "discount") s.discounts = ["di_other"];
      if (fault === "hold") s.pause_collection = null;
      if (fault === "invalid_active") Object.assign(price, { active: "false" });
      expect(() => phase === "bootstrap" ? assertMembershipHeld(s, f.a, f.customer.id, f.product.id, true) :
        assertMembershipActivated(s, f.a, f.product.id, (f as ReturnType<typeof membershipRenewalFixture>).proof)).toThrow();
    }
  });
