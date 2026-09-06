"use client";

import { useState, useCallback } from "react";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { Star } from "lucide-react";
import { NO_PURCHASE_FROM_CREATOR_MESSAGE, type PurchasedPost } from "@/lib/reviewMessages";

type ReviewFormProps = {
  creatorId: string;
  /** The offers this viewer bought from the creator; a review names one of them. */
  offers: PurchasedPost[];
  onReviewSubmitted?: () => void;
  existingRating?: number | null;
  existingComment?: string | null;
};

export default function ReviewForm({
  creatorId,
  offers,
  onReviewSubmitted,
  existingRating = null,
  existingComment = null,
}: ReviewFormProps) {
  const supabase = createClient();
  const { userId } = useUser();
  const [postId, setPostId] = useState<string>(offers[0]?.post_id ?? "");
  const [rating, setRating] = useState<number>(existingRating ?? 0);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [comment, setComment] = useState<string>(existingComment ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!userId) {
        setError("Please sign in to leave a review.");
        return;
      }

      if (!postId) {
        setError("Please choose the offer you bought.");
        return;
      }

      if (rating === 0) {
        setError("Please select a star rating.");
        return;
      }

      if (!comment.trim()) {
        setError("Please write a review comment.");
        return;
      }

      setSubmitting(true);
      setError(null);

      try {
        const response = await fetch(`/api/reviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creator_id: creatorId,
            post_id: postId,
            rating,
            comment: comment.trim(),
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          // 403 PURCHASE_REQUIRED (and every other refusal) is shown inline
          // below the form via setError — never alert().
          throw new Error(data.error || "Failed to submit review");
        }

        // Show success message
        setSuccess(true);
        
        // Reset form
        setRating(0);
        setComment("");
        setHoverRating(null);
        
        // Refresh the page after a short delay to show the new review
        setTimeout(() => {
          if (onReviewSubmitted) {
            onReviewSubmitted();
          } else {
            window.location.reload();
          }
        }, 1000);
      } catch (err: any) {
        console.error("Review submission error:", err);
        setError(err.message || "Failed to submit review. Please try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [userId, creatorId, postId, rating, comment, onReviewSubmitted]
  );

  if (!userId) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
        Please sign in to leave a review.
      </div>
    );
  }

  // The page only renders this form for a buyer; if it is ever mounted with
  // nothing to review, say so instead of offering an empty select.
  if (offers.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
        {NO_PURCHASE_FROM_CREATOR_MESSAGE}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <h3 className="mb-4 text-lg font-semibold text-white">Write a Review</h3>

      {/* Which offer — one review per offer you bought */}
      <div className="mb-4">
        <label
          htmlFor="review-offer"
          className="mb-2 block text-sm font-medium text-white/80"
        >
          Offer <span className="text-red-400">*</span>
        </label>
        <select
          id="review-offer"
          value={postId}
          onChange={(e) => setPostId(e.target.value)}
          className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white focus:border-[#4A35C7] focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/50"
          required
        >
          {offers.map((offer) => (
            <option key={offer.post_id} value={offer.post_id}>
              {offer.title}
            </option>
          ))}
        </select>
      </div>

      {/* Star Rating */}
      <div className="mb-4">
        <label className="mb-2 block text-sm font-medium text-white/80">
          Rating <span className="text-red-400">*</span>
        </label>
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4, 5].map((star) => {
            const isActive = (hoverRating ?? rating) >= star;
            return (
              <button
                key={star}
                type="button"
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(null)}
                onClick={() => setRating(star)}
                className={`transition-transform hover:scale-110 ${
                  isActive ? "text-[#4A35C7]" : "text-gray-500"
                }`}
                aria-label={`Rate ${star} star${star > 1 ? "s" : ""}`}
              >
                <Star
                  className={`h-8 w-8 ${
                    isActive ? "fill-current" : "fill-none"
                  } stroke-current`}
                  strokeWidth={1.5}
                />
              </button>
            );
          })}
          {rating > 0 && (
            <span className="ml-2 text-sm text-white/60">
              {rating} star{rating > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Review Comment */}
      <div className="mb-4">
        <label
          htmlFor="review-comment"
          className="mb-2 block text-sm font-medium text-white/80"
        >
          Your Review <span className="text-red-400">*</span>
        </label>
        <textarea
          id="review-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Share your experience with this creator..."
          rows={4}
          maxLength={1000}
          className="w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-white placeholder:text-white/40 focus:border-[#4A35C7] focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/50"
          required
        />
        <p className="mt-1 text-xs text-white/50">
          {comment.length}/1000 characters
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg bg-red-500/20 border border-red-500/50 px-4 py-2 text-sm text-red-200"
        >
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="mb-4 rounded-lg bg-green-500/20 border border-green-500/50 px-4 py-2 text-sm text-green-200"
        >
          Review submitted successfully! Refreshing...
        </div>
      )}

      {/* Submit Button */}
      <button
        type="submit"
        disabled={submitting || !postId || rating === 0 || !comment.trim()}
        className="w-full rounded-lg bg-[#4A35C7] px-6 py-3 font-semibold text-white transition hover:bg-[#3D2BA3] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/50"
      >
        {submitting ? "Submitting..." : "Submit Review"}
      </button>
    </form>
  );
}

