"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Ellipsis, EyeOff, Flag, Trash2 } from "lucide-react";
import { getActionSession } from "@/lib/actionSession";
import { useUser } from "@/lib/useUser";
import { REPORT_REASONS, type ReportReason } from "@/lib/postReports";

const emptySubscribe = () => () => {};

export default function DeleteVideoButton({ postId, creatorId, onDeleted, onNotInterested }: {
  postId: string;
  creatorId: string | null;
  onDeleted: () => void;
  onNotInterested?: () => void;
}) {
  const { userId, loading } = useUser();
  const dialog = useRef<HTMLDialogElement>(null);
  const reportDialog = useRef<HTMLDialogElement>(null);
  const options = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | undefined>();
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<ReportReason | null>(null);
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const reportInFlight = useRef(false);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const isOwner = Boolean(userId && userId === creatorId);

  if (loading) return null;

  async function submitReport() {
    if (reportInFlight.current || !reportReason) return;
    reportInFlight.current = true;
    setReportBusy(true);
    setReportError(null);
    try {
      const { data, error: sessionError } = await getActionSession();
      if (sessionError || !data.session?.access_token || !userId || data.session.user.id !== userId) {
        throw Error("Please sign in to report this video.");
      }
      const response = await fetch("/api/post-reports", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ postId, reason: reportReason, details: reportDetails.trim() }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw Error(result.error || "Could not send your report. Please try again.");
      setReportSent(true);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Could not send your report. Please try again.");
    } finally {
      reportInFlight.current = false;
      setReportBusy(false);
    }
  }

  async function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { data, error: sessionError } = await getActionSession();
      if (sessionError || !data.session?.access_token || data.session.user.id !== creatorId) {
        throw Error("Please sign in again before deleting this video.");
      }
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
        method: "DELETE", credentials: "include",
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const result = await response.json();
      if (!response.ok || result.deleted !== true) throw Error(result.error || "Could not delete this video. Please try again.");
      dialog.current?.close();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this video. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" aria-label="Video options" title="Video options" aria-haspopup="dialog" aria-expanded={optionsOpen}
      className="mx-auto flex h-11 w-11 items-center justify-center bg-transparent text-white/75 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition(window.innerWidth >= 1024 ? { top: Math.max(8, rect.top - 70), left: Math.max(8, Math.min(rect.right - 208, window.innerWidth - 216)) } : undefined);
        setOptionsOpen(true); options.current?.showModal();
      }}>
      <Ellipsis className="h-6 w-6" aria-hidden="true" />
    </button>
    {mounted && createPortal(
      <dialog ref={options} aria-label="Video options" style={menuPosition}
        onClose={() => { setOptionsOpen(false); if (!dialog.current?.open && !reportDialog.current?.open) trigger.current?.focus(); }}
        onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) options.current?.close(); }}
        onKeyDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
        className="fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none rounded-t-2xl border border-white/15 bg-[#17141d] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-white shadow-2xl backdrop:bg-black/60 lg:bottom-auto lg:right-auto lg:w-52 lg:rounded-xl lg:p-1.5 lg:backdrop:bg-transparent">
        <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-white/25 lg:hidden" />
        {isOwner ? (
          <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-red-300 hover:bg-white/5"
            onClick={() => { options.current?.close(); setOptionsOpen(false); setError(null); dialog.current?.showModal(); cancel.current?.focus(); }}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />Delete video
          </button>
        ) : (
          <>
            {onNotInterested && <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-white hover:bg-white/5"
              onClick={() => { options.current?.close(); setOptionsOpen(false); onNotInterested(); }}>
              <EyeOff className="h-4 w-4" aria-hidden="true" />Not interested
            </button>}
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-white hover:bg-white/5"
              onClick={() => { options.current?.close(); setOptionsOpen(false); setReportError(null); setReportSent(false); setReportReason(null); setReportDetails(""); reportDialog.current?.showModal(); }}>
              <Flag className="h-4 w-4" aria-hidden="true" />Report video
            </button>
          </>
        )}
        <button type="button" onClick={() => options.current?.close()} className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm lg:hidden">Cancel</button>
      </dialog>, document.body)}
    {!isOwner && mounted && createPortal(
      <dialog ref={reportDialog} aria-labelledby={`report-title-${postId}`}
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => { if (reportInFlight.current) event.preventDefault(); }}
        onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !reportInFlight.current) reportDialog.current?.close(); }}
        onKeyDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
        className="fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none rounded-t-2xl border border-white/15 bg-[#17141d] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-white shadow-2xl backdrop:bg-black/70 lg:inset-0 lg:m-auto lg:w-[calc(100%-2rem)] lg:max-w-md lg:rounded-2xl lg:bg-[#111015] lg:p-6">
        <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-white/25 lg:hidden" />
        {reportSent ? <>
          <h2 id={`report-title-${postId}`} className="text-lg font-semibold">Report received</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">Thanks for letting us know. Our team can now review this video.</p>
          <button type="button" onClick={() => reportDialog.current?.close()} className="mt-6 w-full rounded-xl bg-[#4934c4] px-4 py-3 text-sm font-semibold hover:bg-[#5944d4]">Done</button>
        </> : !userId ? <>
          <h2 id={`report-title-${postId}`} className="text-lg font-semibold">Sign in to report</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">Sign in so our team can review your report and prevent duplicate submissions.</p>
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" onClick={() => reportDialog.current?.close()} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-white/5">Cancel</button>
            <Link href="/auth" className="rounded-xl bg-[#4934c4] px-4 py-2.5 text-sm font-semibold hover:bg-[#5944d4]">Sign in</Link>
          </div>
        </> : <>
          <h2 id={`report-title-${postId}`} className="text-lg font-semibold">Report video</h2>
          <p className="mt-1 text-sm text-white/65">Why are you reporting this video?</p>
          <fieldset className="mt-5 space-y-1">
            <legend className="sr-only">Report reason</legend>
            {REPORT_REASONS.map((reason) => <label key={reason.value} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-white/5">
              <input type="radio" name={`report-reason-${postId}`} value={reason.value} checked={reportReason === reason.value}
                onChange={() => setReportReason(reason.value)} className="accent-[#4934c4]" />
              {reason.label}
            </label>)}
          </fieldset>
          <label htmlFor={`report-details-${postId}`} className="mt-4 block text-sm font-medium">Details <span className="font-normal text-white/50">(optional)</span></label>
          <textarea id={`report-details-${postId}`} value={reportDetails} maxLength={500} rows={3}
            onChange={(event) => setReportDetails(event.target.value)} placeholder="Tell us what happened"
            className="mt-2 w-full resize-none rounded-xl border border-white/15 bg-white/5 p-3 text-sm text-white placeholder:text-white/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400" />
          <p className="mt-1 text-right text-xs text-white/45">{reportDetails.length}/500</p>
          {reportError && <p role="alert" className="mt-2 text-sm text-red-300">{reportError}</p>}
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" disabled={reportBusy} onClick={() => reportDialog.current?.close()}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-white/5 disabled:opacity-50">Cancel</button>
            <button type="button" disabled={reportBusy || !reportReason} onClick={submitReport}
              className="rounded-xl bg-[#4934c4] px-4 py-2.5 text-sm font-semibold hover:bg-[#5944d4] disabled:opacity-50">{reportBusy ? "Sending…" : "Submit report"}</button>
          </div>
        </>}
      </dialog>, document.body)}
    {isOwner && mounted && createPortal(
      <dialog ref={dialog} aria-labelledby={`delete-title-${postId}`} aria-describedby={`delete-description-${postId}`}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
        onCancel={(event) => { if (inFlight.current) event.preventDefault(); }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-white/15 bg-[#111015] p-6 text-white shadow-2xl backdrop:bg-black/70">
        <h2 id={`delete-title-${postId}`} className="text-lg font-semibold">Delete video?</h2>
        <p id={`delete-description-${postId}`} className="mt-2 text-sm leading-6 text-white/65">This removes the video from your profile and feed. Buyers keep access to everything they already paid for.</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancel} type="button" disabled={busy} onClick={() => dialog.current?.close()}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button type="button" disabled={busy} onClick={remove}
            className="rounded-xl bg-[#4934c4] px-4 py-2 text-sm font-semibold hover:bg-[#5944d4] disabled:opacity-50">{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </dialog>, document.body)}
  </>;
}
