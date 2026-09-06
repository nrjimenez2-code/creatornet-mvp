"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Phone, PlayCircle, ShieldCheck, Star, Tag, Users } from "lucide-react";
import SidePanel from "@/components/SidePanel";
import { useUser } from "@/lib/useUser";
import { formatOfferPrice, type OfferCard, type OfferKind } from "@/lib/offers";
import {
  bookingCheckoutPayload,
  navigateTo,
  productCheckoutPayload,
  startCheckout,
} from "@/lib/checkoutClient";

// ---------------------------------------------------------------------------
// Defaults the founder has not decided yet — each is the ONE place to change.
// ---------------------------------------------------------------------------
/** Render the Offers trigger even when the creator has no offers. */
export const SHOW_OFFERS_BUTTON_WHEN_EMPTY = false;
/** Buy CTA text while the creator has not finished Stripe Connect. */
export const NOT_SELL_READY_LABEL = "Not accepting payments yet";
/** Where a signed-out click on a CTA goes. */
export const SIGNED_OUT_REDIRECT = "/auth";
/** Panel copy. */
export const OFFERS_COPY = {
  title: "Offers",
  description: (name: string) => `Exclusive products and services from ${name}.`,
  empty: "No offers yet.",
  footer: "Secure payments powered by CreatorNet",
  busy: "Starting…",
} as const;

export type OffersRating = { avgRating: number; reviewCount: number };

type Props = {
  creatorId: string;
  creatorName: string;
  offers: OfferCard[];
  /** lib/creatorStripeConnect.isCreatorSellReady, computed server-side. */
  sellReady: boolean;
  /** Creator-level rating (get_profile_rating); null hides the line. */
  rating: OffersRating | null;
};

const KIND_ICON: Record<OfferKind, typeof BookOpen> = {
  course: BookOpen,
  mentorship: Users,
  consultation: Phone,
  video: PlayCircle,
};

function OfferImage({ card }: { card: OfferCard }) {
  if (card.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={card.imageUrl} alt="" className="h-full w-full object-cover" />
    );
  }
  const Icon = KIND_ICON[card.kind];
  return <Icon aria-hidden="true" className="h-10 w-10 text-[#8B7CF7]" />;
}

export default function OffersPanel({ creatorId, creatorName, offers, sellReady, rating }: Props) {
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();
  const { userId, loading: authLoading } = useUser();

  if (offers.length === 0 && !SHOW_OFFERS_BUTTON_WHEN_EMPTY) return null;

  const isPurchase = (card: OfferCard) => card.productId !== null;
  const isDisabled = (card: OfferCard) =>
    busyKey !== null || (isPurchase(card) && !sellReady);

  async function handleCta(card: OfferCard) {
    if (authLoading || busyKey) return;
    if (!userId) {
      router.push(SIGNED_OUT_REDIRECT);
      return;
    }

    setBusyKey(card.key);
    setErrors((prev) => ({ ...prev, [card.key]: "" }));
    try {
      const payload = card.productId
        ? productCheckoutPayload({
            productId: card.productId,
            postId: card.postId,
            creatorId,
            titleForCheckout: card.title,
            buyerId: userId,
          })
        : bookingCheckoutPayload({
            postId: card.postId,
            creatorId,
            bookingRedirectUrl: card.bookingUrl ?? "",
          });
      const url = await startCheckout(payload);
      // Stay busy while the browser navigates to Stripe.
      navigateTo(url);
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : "Checkout could not be started.";
      setErrors((prev) => ({ ...prev, [card.key]: message }));
      setBusyKey(null);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-md border border-[#4A35C7] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[#4A35C7]/20"
      >
        <Tag aria-hidden="true" className="h-4 w-4" />
        Offers
      </button>

      <SidePanel
        open={open}
        onClose={() => setOpen(false)}
        title={OFFERS_COPY.title}
        description={OFFERS_COPY.description(creatorName)}
        returnFocusRef={triggerRef}
        footer={
          <p className="flex items-center justify-center gap-2 text-xs text-white/60">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {OFFERS_COPY.footer}
          </p>
        }
      >
        {rating && rating.reviewCount > 0 ? (
          <Link
            href={`/creators/${creatorId}/reviews`}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-white/80 hover:text-white"
          >
            <Star aria-hidden="true" className="h-4 w-4 fill-[#F5B301] text-[#F5B301]" />
            <span>
              {rating.avgRating.toFixed(1)} · {rating.reviewCount}{" "}
              {rating.reviewCount === 1 ? "review" : "reviews"}
            </span>
          </Link>
        ) : null}

        {offers.length === 0 ? (
          <p className="text-sm text-white/60">{OFFERS_COPY.empty}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {offers.map((card) => {
              const disabled = isDisabled(card);
              const notSellReady = isPurchase(card) && !sellReady;
              const error = errors[card.key];
              return (
                <li
                  key={card.key}
                  className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4"
                  data-offer-kind={card.kind}
                >
                  <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#1B1530] sm:h-28 sm:w-28">
                    <OfferImage card={card} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold tracking-wide text-[#8B7CF7]">{card.label}</p>
                    <h3 className="mt-1 text-base font-semibold text-white">{card.title}</h3>
                    {card.description ? (
                      <p className="mt-1 text-sm text-white/60">{card.description}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                      {card.priceCents !== null ? (
                        <p className="text-2xl font-semibold">
                          {formatOfferPrice(card.priceCents, card.currency)}
                        </p>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        onClick={() => handleCta(card)}
                        disabled={disabled}
                        className="rounded-md bg-[#4A35C7] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[#3D2BA3] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {notSellReady
                          ? NOT_SELL_READY_LABEL
                          : busyKey === card.key
                            ? OFFERS_COPY.busy
                            : card.cta}
                      </button>
                    </div>
                    {error ? (
                      <p role="alert" className="mt-2 text-sm text-red-300">
                        {error}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SidePanel>
    </>
  );
}
