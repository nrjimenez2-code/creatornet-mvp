"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";

interface ProfileStarRatingProps {
  userId: string;
  rating: number;
  reviewCount: number;
  enableNavigation?: boolean;
}

export default function ProfileStarRating({
  userId,
  rating,
  reviewCount,
  enableNavigation = true,
}: ProfileStarRatingProps) {
  const supabase = createClient();
  const [currentRating, setCurrentRating] = useState(Number(rating) || 0);
  const [currentCount, setCurrentCount] = useState(Number(reviewCount) || 0);
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleNavigate = useCallback(() => {
    if (!enableNavigation || !userId) return;
    router.push(`/creators/${userId}/reviews`);
  }, [enableNavigation, router, userId]);

  const handleSummaryKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!enableNavigation) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleNavigate();
      }
    },
    [enableNavigation, handleNavigate]
  );

  async function setRating(value: number) {
    if (!userId || loading) return;
    setLoading(true);

    const { data: auth } = await supabase.auth.getUser();
    const reviewerId = auth?.user?.id;
    if (!reviewerId) {
      alert("Please sign in to leave a review.");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.rpc("set_profile_rating", {
      p_profile_id: userId,
      p_reviewer_id: reviewerId,
      p_rating: value,
    });

    if (!error && data && data.length) {
      const result = data[0];
      setCurrentRating(result.avg_rating ?? 0);
      setCurrentCount(result.review_count ?? 0);
    }

    setLoading(false);
  }

  function renderStar(index: number) {
    const value = hoverValue ?? currentRating;
    const active = value >= index - 0.25;
    const colorClass = hoverValue ? "text-purple-400" : active ? "text-purple-400" : "text-gray-400";
    return (
      <button
        key={index}
        type="button"
        onMouseEnter={() => setHoverValue(index)}
        onMouseLeave={() => setHoverValue(null)}
        onClick={() => setRating(index)}
        className={`transition ${colorClass}`}
        aria-label={`Rate ${index} star`}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current">
          <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2z" />
        </svg>
      </button>
    );
  }

  if (currentCount === 0 && currentRating === 0) {
    return (
      <div className="flex items-center gap-2 text-white/70">
        <div
          role={enableNavigation ? "button" : undefined}
          tabIndex={enableNavigation ? 0 : undefined}
          onClick={enableNavigation ? handleNavigate : undefined}
          onKeyDown={enableNavigation ? handleSummaryKey : undefined}
          className={`text-sm ${
            enableNavigation
              ? "cursor-pointer underline decoration-dotted decoration-white/40 underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              : ""
          }`}
        >
          Be the first to review
        </div>
        <div className="flex items-center gap-1">{[1].map(renderStar)}</div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {[1].map(renderStar)}
      </div>
      <div
        role={enableNavigation ? "button" : undefined}
        tabIndex={enableNavigation ? 0 : undefined}
        onClick={enableNavigation ? handleNavigate : undefined}
        onKeyDown={enableNavigation ? handleSummaryKey : undefined}
        className={`text-sm text-white/70 ${
          enableNavigation
            ? "cursor-pointer underline decoration-dotted decoration-white/40 underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            : ""
        }`}
      >
        {currentRating.toFixed(1)} <span className="text-xs ml-1">({currentCount} reviews)</span>
      </div>
    </div>
  );
}
