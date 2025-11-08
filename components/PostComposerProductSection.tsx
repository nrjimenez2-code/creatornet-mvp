'use client';

import React, { useState } from 'react';
import ProductFields, { ProductDraft } from './ProductFields';

export default function PostComposerProductSection({
  onSaved,
}: {
  onSaved?: (productId: string) => void;
}) {
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveProduct() {
    if (!draft) return;
    if (!draft.title) return alert('Add a title');
    if (!draft.price_cents || !draft.stripe_price_id)
      return alert('Set a price and Stripe price id first');

    try {
      setSaving(true);

      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          price_cents: draft.price_cents,
          plan_months: draft.plan_months,
          fulfillment: draft.fulfillment,
          discord_channel_id: draft.discord_channel_id || null,
          whop_listing_id: draft.whop_listing_id || null,
          stripe_price_id: draft.stripe_price_id,
        }),
      });

      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed to save product');

      if (onSaved) onSaved(j.id);

      alert('Product attached');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-4 space-y-4">
      <h3 className="text-lg font-semibold">Attach a Product</h3>

      <ProductFields
        initial={{
          plan_months: 1,
          fulfillment: 'DISCORD',
        }}
        onChange={(p) => setDraft(p)}
      />

      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={saveProduct}
          className="rounded-2xl bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Attach to Post'}
        </button>
      </div>
    </div>
  );
}
