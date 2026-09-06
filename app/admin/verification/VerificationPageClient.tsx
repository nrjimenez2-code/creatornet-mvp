"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActionButton,
  Avatar,
  COUNT_CHIP_CLASS,
  EmptyState,
  PageHeader,
  Panel,
  ROW_HOVER_CLASS,
  TH_CLASS,
} from "@/components/admin/ui";
import { IconBan, IconCheck, IconX } from "@/components/admin/icons";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { useToast } from "@/components/admin/Toast";
import type { AdminVerificationCreator, AdminVerificationRequest } from "./data";

const ARM_TIMEOUT_MS = 4000;
const MAX_REASON_LENGTH = 500;

type Decision = "approve" | "reject" | "revoke";

const STATUS_LABEL: Record<AdminVerificationRequest["status"], string> = {
  code_issued: "Waiting for check",
  approved: "Verified",
  rejected: "Rejected",
  revoked: "Revoked",
};

const STATUS_CHIP: Record<AdminVerificationRequest["status"], string> = {
  code_issued: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-blue-50 text-blue-700 border-blue-200",
  rejected: "bg-gray-100 text-gray-600 border-gray-200",
  revoked: "bg-red-50 text-red-700 border-red-200",
};

const PLATFORM_LABEL = { instagram: "Instagram", tiktok: "TikTok" } as const;

function displayName(creator: AdminVerificationCreator): string {
  return creator.fullName ?? creator.username ?? "Unknown";
}

function StatusChip({ status }: { status: AdminVerificationRequest["status"] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS_CHIP[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function VerificationPageClient({ requests }: { requests: AdminVerificationRequest[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<{ id: string; decision: Decision } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const disarmTimerRef = useRef<number | null>(null);

  const pendingCount = requests.filter((r) => r.status === "code_issued").length;

  // A two-step confirm for the two "take something away" decisions that never
  // stays armed forever.
  useEffect(() => {
    if (armed === null) return;
    disarmTimerRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
    return () => {
      if (disarmTimerRef.current !== null) {
        window.clearTimeout(disarmTimerRef.current);
      }
    };
  }, [armed]);

  const decide = async (request: AdminVerificationRequest, decision: Decision) => {
    if (busyId !== null) return;
    const needsConfirm = decision !== "approve";
    if (needsConfirm && (armed?.id !== request.id || armed.decision !== decision)) {
      setArmed({ id: request.id, decision });
      return;
    }
    setArmed(null);
    setBusyId(request.id);
    try {
      const reason = (reasons[request.id] ?? "").trim();
      const res = await fetch("/api/admin/verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.id, decision, reason: reason || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const verb = decision === "approve" ? "verified" : decision === "reject" ? "rejected" : "revoked";
      toast("success", `${displayName(request.creator)} ${verb}`);
      setReasons((prev) => {
        const next = { ...prev };
        delete next[request.id];
        return next;
      });
      // No optimistic copy of the queue: the server page re-fetches and the
      // fresh rows arrive as props.
      router.refresh();
    } catch (err) {
      console.error("[admin/verification] decision failed:", err);
      toast("danger", err instanceof Error ? err.message : "Failed to update request");
    } finally {
      setBusyId(null);
    }
  };

  const isArmed = (request: AdminVerificationRequest, decision: Decision) =>
    armed?.id === request.id && armed.decision === decision;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Verification"
        subtitle="Blue authenticity checks — open the creator's profile, look for their code in the bio, then approve or reject. Approved badges can be revoked later."
      />

      <Panel
        title="Requests"
        tinted={pendingCount > 0}
        action={
          pendingCount > 0 ? (
            <span className={COUNT_CHIP_CLASS}>{pendingCount} waiting</span>
          ) : (
            <span className="text-[11px] text-gray-400">nothing waiting</span>
          )
        }
      >
        {requests.length === 0 ? (
          <EmptyState message="No verification requests yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} pl-5`}>Creator</th>
                  <th className={TH_CLASS}>Account</th>
                  <th className={TH_CLASS}>Code in bio</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={TH_CLASS}>Requested</th>
                  <th className={`${TH_CLASS} text-right`}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => {
                  const canDecidePending = request.status === "code_issued";
                  const canRevoke = request.status === "approved";
                  const showActions = canDecidePending || canRevoke;
                  const isBusy = busyId === request.id;
                  const reasonId = `reason-${request.id}`;
                  return (
                    <tr key={request.id} className={`${ROW_HOVER_CLASS} align-top`}>
                      <td className="px-3 py-2.5 pl-5">
                        <span className="inline-flex items-center gap-2">
                          <Avatar id={request.creator.id} name={displayName(request.creator)} size={26} />
                          <span className="min-w-0">
                            <span className="block font-medium text-gray-800">
                              {displayName(request.creator)}
                            </span>
                            {request.creator.username ? (
                              <span className="block text-xs text-gray-400">@{request.creator.username}</span>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <a
                          href={request.profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-[#7c5cbf] underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none"
                        >
                          {PLATFORM_LABEL[request.platform]} @{request.handle}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      </td>
                      <td className="px-3 py-2.5">
                        {request.code ? (
                          <code className="rounded-md bg-[#f3eefc] px-2 py-1 font-mono text-xs font-bold tracking-wide text-[#4A35C7]">
                            {request.code}
                          </code>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusChip status={request.status} />
                        {request.reason ? (
                          <span className="mt-1 block max-w-[200px] text-xs text-gray-500" title={request.reason}>
                            {request.reason}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-500">
                        <TimeAgo iso={request.createdAt} />
                        {request.decidedAt ? (
                          <span className="block text-xs text-gray-400">
                            decided <TimeAgo iso={request.decidedAt} />
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {showActions ? (
                          <div className="flex flex-col items-end gap-1.5">
                            <div className="flex items-center justify-end gap-1.5">
                              {canDecidePending ? (
                                <>
                                  <ActionButton
                                    variant="approve"
                                    title="Code found in bio — turn on the blue check"
                                    onClick={() => void decide(request, "approve")}
                                  >
                                    <IconCheck size={13} />
                                    {isBusy ? "Saving…" : "Approve"}
                                  </ActionButton>
                                  <ActionButton
                                    variant="danger"
                                    armed={isArmed(request, "reject")}
                                    title={
                                      isArmed(request, "reject")
                                        ? "Click again to reject this request"
                                        : "Code not in bio — reject"
                                    }
                                    onClick={() => void decide(request, "reject")}
                                  >
                                    <IconX size={13} />
                                    {isArmed(request, "reject") ? "Confirm reject" : "Reject"}
                                  </ActionButton>
                                </>
                              ) : (
                                <ActionButton
                                  variant="danger"
                                  armed={isArmed(request, "revoke")}
                                  title={
                                    isArmed(request, "revoke")
                                      ? "Click again to remove the blue check"
                                      : "Remove the blue check"
                                  }
                                  onClick={() => void decide(request, "revoke")}
                                >
                                  <IconBan size={13} />
                                  {isBusy ? "Saving…" : isArmed(request, "revoke") ? "Confirm revoke" : "Revoke"}
                                </ActionButton>
                              )}
                            </div>
                            <label htmlFor={reasonId} className="sr-only">
                              Reason (optional)
                            </label>
                            <input
                              id={reasonId}
                              type="text"
                              value={reasons[request.id] ?? ""}
                              maxLength={MAX_REASON_LENGTH}
                              placeholder="Reason (optional)"
                              onChange={(event) =>
                                setReasons((prev) => ({ ...prev, [request.id]: event.target.value }))
                              }
                              className="w-48 rounded-lg border border-[#e5ddf5] bg-white/90 px-2.5 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB]"
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
