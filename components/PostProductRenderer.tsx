'use client';

import React, { useState } from 'react';

type Product = {
  id: string;
  title: string;
  price_cents: number;
  plan_months: number;
  stripe_price_id: string;
  fulfillment: 'FILE' | 'DISCORD' | 'WHOP';
};

export default function PostProductRenderer({
  product,
}: {
  product: Product | null | undefined;
}) {
  const [loading, setLoading] = useState(false);

  // UI guard: nothing to render if no product
  if (!product) return null;

  const priceUSD = (product.price_cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
  });

  const paymentText =
    product.plan_months > 1
      ? `$${priceUSD} / month for ${product.plan_months} months`
      : `$${priceUSD} one-time`;

  async function handleBuy() {
    // TS guard inside the handler (closure doesn't narrow from the outer check)
    if (!product) return;
    try {
      setLoading(true);
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Checkout error');
      window.location.href = j.url; // Stripe Checkout
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3 rounded-2xl border p-4 space-y-2">
      <div className="text-base font-semibold">{product.title}</div>
      <div className="text-sm text-gray-600">{paymentText}</div>
      <button
        type="button"
        disabled={loading}
        onClick={handleBuy}
        className="mt-2 w-full rounded-xl bg-black py-2 text-white text-center disabled:opacity-60"
      >
        {loading ? 'Redirecting…' : 'Buy'}
      </button>
    </div>
  );
}
