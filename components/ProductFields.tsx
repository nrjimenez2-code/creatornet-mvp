'use client';

import React, { useEffect, useMemo, useState } from 'react';

export type Fulfillment = 'FILE' | 'DISCORD' | 'WHOP';

export type ProductDraft = {
  title: string;
  price_cents: number;     // store cents
  plan_months: number;     // 1 = one-time; >1 = fixed-term monthly
  fulfillment: Fulfillment;
  discord_channel_id?: string;
  whop_listing_id?: string;
  stripe_price_id?: string;
};

type Props = {
  initial?: Partial<ProductDraft>;
  onChange?: (p: ProductDraft) => void;
};

const currencyToCents = (v: string) => Math.round((Number(v || '0') || 0) * 100);
const centsToCurrency = (c?: number) =>
  typeof c === 'number' && !Number.isNaN(c) ? (c / 100).toString() : '';

export default function ProductFields({ initial, onChange }: Props) {
  const [state, setState] = useState<ProductDraft>({
    title: initial?.title ?? '',
    price_cents: initial?.price_cents ?? 0,
    plan_months: initial?.plan_months ?? 1,
    fulfillment: (initial?.fulfillment as Fulfillment) ?? 'FILE',
    discord_channel_id: initial?.discord_channel_id ?? '',
    whop_listing_id: initial?.whop_listing_id ?? '',
    stripe_price_id: initial?.stripe_price_id ?? '',
  });

  const [creatingPrice, setCreatingPrice] = useState(false);

  useEffect(() => {
    onChange?.(state);
  }, [state, onChange]);

  const monthlyOrOnce = useMemo(
    () => (state.plan_months > 1 ? 'monthly' : 'one-time'),
    [state.plan_months]
  );

  async function createPrice() {
    try {
      setCreatingPrice(true);
      const res = await fetch('/api/admin/stripe/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_amount_cents: state.price_cents,
          plan_months: state.plan_months,
          product_name: state.title || 'CreatorNet Product',
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed to create price');
      setState((s) => ({ ...s, stripe_price_id: j.price_id }));
      alert('Stripe price created and attached');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setCreatingPrice(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium">Title</label>
        <input
          className="mt-1 w-full rounded border p-2"
          value={state.title}
          onChange={(e) => setState({ ...state, title: e.target.value })}
          placeholder="Course or Mentorship title"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium">Price (USD)</label>
          <input
            type="number"
            className="mt-1 w-full rounded border p-2"
            min={0}
            value={centsToCurrency(state.price_cents)}
            onChange={(e) =>
              setState({ ...state, price_cents: currencyToCents(e.target.value) })
            }
            placeholder="e.g., 1000 for $1,000"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Plan months</label>
          <input
            type="number"
            className="mt-1 w-full rounded border p-2"
            min={1}
            value={state.plan_months}
            onChange={(e) =>
              setState({
                ...state,
                plan_months: Math.max(1, Number(e.target.value || '1')),
              })
            }
            placeholder="1 = one-time; >1 = monthly plan"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium">Fulfillment</label>
        <select
          className="mt-1 w-full rounded border p-2"
          value={state.fulfillment}
          onChange={(e) =>
            setState({ ...state, fulfillment: e.target.value as Fulfillment })
          }
        >
          <option value="FILE">File (no invite)</option>
          <option value="DISCORD">Discord (expiring invite)</option>
          <option value="WHOP">Whop (issue membership)</option>
        </select>
      </div>

      {state.fulfillment === 'DISCORD' && (
        <div>
          <label className="block text-sm font-medium">Discord Channel ID</label>
          <input
            className="mt-1 w-full rounded border p-2"
            value={state.discord_channel_id}
            onChange={(e) =>
              setState({ ...state, discord_channel_id: e.target.value })
            }
            placeholder="123456789012345678"
          />
        </div>
      )}

      {state.fulfillment === 'WHOP' && (
        <div>
          <label className="block text-sm font-medium">Whop Listing ID</label>
          <input
            className="mt-1 w-full rounded border p-2"
            value={state.whop_listing_id}
            onChange={(e) =>
              setState({ ...state, whop_listing_id: e.target.value })
            }
            placeholder="prod_... or listing id from Whop"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={creatingPrice || !state.price_cents}
          onClick={createPrice}
          className="rounded-2xl bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {creatingPrice ? 'Creating price…' : `Create Stripe Price (${monthlyOrOnce})`}
        </button>
        <input
          className="flex-1 rounded border p-2"
          placeholder="stripe_price_id"
          value={state.stripe_price_id || ''}
          onChange={(e) => setState({ ...state, stripe_price_id: e.target.value })}
        />
      </div>
    </div>
  );
}
