"use client";

import { useEffect, useRef, useState } from "react";
import {
  ActionButton,
  Avatar,
  EmptyState,
  PageHeader,
  Panel,
  ROW_HOVER_CLASS,
  TH_CLASS,
} from "@/components/admin/ui";
import { IconStar, IconTrash } from "@/components/admin/icons";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { useToast } from "@/components/admin/Toast";
import type { AdminReview, AdminReviewPerson } from "./data";

const ARM_TIMEOUT_MS = 4000;

function displayName(person: AdminReviewPerson | null): string {
  if (!person) return "Unknown";
  return person.fullName ?? person.username ?? "Unknown";
}

function Stars({ rating }: { rating: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-amber-500"
      aria-label={`${rating} out of 5 stars`}
    >
      <IconStar size={13} />
      <span className="text-xs font-semibold text-gray-700">{rating}/5</span>
    </span>
  );
}

export function ReviewsPageClient({ initialReviews }: { initialReviews: AdminReview[] }) {
  const [reviews, setReviews] = useState<AdminReview[]>(initialReviews);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const disarmTimerRef = useRef<number | null>(null);
  const { toast } = useToast();

  // A two-step confirm that never stays armed forever.
  useEffect(() => {
    if (armedId === null) return;
    disarmTimerRef.current = window.setTimeout(() => setArmedId(null), ARM_TIMEOUT_MS);
    return () => {
      if (disarmTimerRef.current !== null) {
        window.clearTimeout(disarmTimerRef.current);
      }
    };
  }, [armedId]);

  const handleRemove = async (review: AdminReview) => {
    if (armedId !== review.id) {
      setArmedId(review.id);
      return;
    }
    setArmedId(null);
    setBusyId(review.id);
    try {
      const res = await fetch("/api/admin/remove-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: review.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setReviews((prev) => prev.filter((r) => r.id !== review.id));
      toast("success", `Review removed — ${displayName(review.creator)}'s rating recalculated`);
    } catch (err) {
      console.error("[admin/reviews] remove failed:", err);
      toast("danger", err instanceof Error ? err.message : "Failed to remove review");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reviews"
        subtitle={`${reviews.length} most recent creator reviews — remove fake or abusive ones; the creator's average rating recalculates automatically`}
      />

      <Panel title="Recent reviews">
        {reviews.length === 0 ? (
          <EmptyState message="No reviews yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Creator</th>
                  <th className={TH_CLASS}>Reviewer</th>
                  <th className={TH_CLASS}>Rating</th>
                  <th className={TH_CLASS}>Comment</th>
                  <th className={TH_CLASS}>Posted</th>
                  <th className={`${TH_CLASS} text-right`}>Action</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={review.id} className={ROW_HOVER_CLASS}>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <Avatar id={review.creator?.id ?? review.id} name={displayName(review.creator)} size={26} />
                        <span className="font-medium text-gray-800">
                          {displayName(review.creator)}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{displayName(review.reviewer)}</td>
                    <td className="px-3 py-2.5">
                      <Stars rating={review.rating} />
                    </td>
                    <td className="max-w-[280px] px-3 py-2.5 text-gray-600">
                      <span className="line-clamp-2" title={review.comment}>
                        {review.comment || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-gray-500">
                      {review.createdAt ? <TimeAgo iso={review.createdAt} /> : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ActionButton
                        variant="danger"
                        armed={armedId === review.id}
                        title={
                          armedId === review.id
                            ? "Click again to permanently remove this review"
                            : "Remove review"
                        }
                        onClick={() => {
                          if (busyId === null) void handleRemove(review);
                        }}
                      >
                        <IconTrash size={13} />
                        {busyId === review.id
                          ? "Removing…"
                          : armedId === review.id
                            ? "Confirm remove"
                            : "Remove"}
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
