"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/admin/Drawer";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { useToast } from "@/components/admin/Toast";
import { ActionButton, FilterPill, Panel, VideoThumb } from "@/components/admin/ui";
import { IconCheck, IconEyeOff, IconFlag, IconTrash } from "@/components/admin/icons";
import { reportReasonLabel, type AdminPostReport, type ReportStatus } from "@/lib/postReports";
import type { ReportPage } from "@/lib/admin/reports";

const FILTERS: { status: ReportStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "reviewed", label: "Reviewed" },
  { status: "dismissed", label: "Dismissed" },
];

export function AdminReportQueue({ initialPage, initialReportId }: { initialPage: ReportPage; initialReportId: string | null }) {
  const router = useRouter();
  const { toast } = useToast();
  const [filter, setFilter] = useState<ReportStatus>("open");
  const [page, setPage] = useState<ReportPage>(initialPage);
  const initialSelection = initialReportId ? initialPage.reports.find((report) => report.id === initialReportId) ?? null : null;
  const [selected, setSelected] = useState<AdminPostReport | null>(initialSelection);
  const requestSequence = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<"remove" | "ban" | null>(null);

  useEffect(() => {
    if (!initialReportId) return;
    if (initialPage.reports.some((report) => report.id === initialReportId)) return;
    let cancelled = false;
    void fetch(`/api/admin/reports/${encodeURIComponent(initialReportId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw Error("Report could not be opened.");
        return response.json() as Promise<{ report: AdminPostReport }>;
      })
      .then((result) => { if (!cancelled) setSelected(result.report); })
      .catch(() => { if (!cancelled) toast("danger", "Report could not be opened."); });
    return () => { cancelled = true; };
  }, [initialPage.reports, initialReportId, toast]);

  async function load(status: ReportStatus, offset: number, append = false) {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(`/api/admin/reports?status=${status}&offset=${offset}`, { cache: "no-store" });
      if (!response.ok) throw Error("Could not load reports.");
      const next = await response.json() as ReportPage;
      if (requestSequence.current === sequence) setPage((previous) => append ? { ...next, reports: [...previous.reports, ...next.reports] } : next);
    } catch {
      if (requestSequence.current === sequence) {
        setLoadError(true);
        toast("danger", "Could not load reports.");
      }
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }

  function changeFilter(status: ReportStatus) {
    if (status === filter) return;
    setFilter(status);
    setSelected(null);
    setPage({ reports: [], total: 0, nextOffset: null });
    void load(status, 0);
  }

  async function postAction(url: string, body: Record<string, string>, success: string) {
    setBusy(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw Error("Action failed.");
      toast("success", success);
      setArmed(null);
      setSelected(null);
      router.refresh();
    } catch {
      toast("danger", "Action failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function retryAlert(report: AdminPostReport) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/reports/${encodeURIComponent(report.id)}/notify`, { method: "POST" });
      if (!response.ok) throw Error("Alert could not be sent.");
      toast("success", "Moderation email sent.");
      setSelected((current) => current?.id === report.id ? { ...current, notificationStatus: "sent" } : current);
      setPage((current) => ({ ...current, reports: current.reports.map((item) => item.id === report.id ? { ...item, notificationStatus: "sent" } : item) }));
    } catch {
      toast("danger", "Email is still unavailable. The report remains saved here.");
    } finally {
      setBusy(false);
    }
  }

  const reports = page.reports;
  return <>
    <div className="mb-6">
      <Panel title="Video reports" tinted action={<span className="rounded-full bg-[#f3eefc] px-2 py-1 text-[11px] font-bold text-[#7c5cbf]">{page.total} {filter}</span>}>
        <div className="flex flex-wrap gap-2 border-b border-[#f0ebfb] px-5 py-3">
          {FILTERS.map((item) => <FilterPill key={item.status} label={item.label} isActive={filter === item.status}
            count={item.status === filter ? page.total : undefined} onClick={() => changeFilter(item.status)} />)}
        </div>
        {loading && reports.length === 0 ? <p className="px-5 py-7 text-sm text-gray-500" role="status">Loading reports…</p> :
          loadError && reports.length === 0 ? <div className="px-5 py-7 text-sm text-red-700" role="alert">Could not load reports. <button type="button" className="underline" onClick={() => void load(filter, 0)}>Try again</button></div> :
          reports.length === 0 ? <p className="px-5 py-7 text-sm text-gray-500">No {filter} reports.</p> :
          <ul className="divide-y divide-[#f0ebfb]">
            {reports.map((report) => <li key={report.id}>
              <button type="button" onClick={() => { setSelected(report); setArmed(null); }}
                className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-[#f8f5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB]">
                <VideoThumb id={report.postId} size={52} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-zinc-900">{report.postTitle}</span>
                  <span className="block text-xs text-gray-500">@{report.creatorUsername} · {reportReasonLabel(report.reason)} · {report.reportCount} {report.reportCount === 1 ? "report" : "reports"}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-gray-400"><TimeAgo iso={report.createdAt} />
                  {report.notificationStatus !== "sent" && <span className="block text-amber-700">Email {report.notificationStatus}</span>}
                </span>
              </button>
            </li>)}
          </ul>}
        {page.nextOffset !== null && <div className="border-t border-[#f0ebfb] p-4 text-center">
          <button type="button" disabled={loading} onClick={() => void load(filter, page.nextOffset!, true)}
            className="rounded-xl border border-[#e5ddf5] px-4 py-2 text-sm font-semibold text-[#6b4fae] hover:bg-[#f8f5ff] disabled:opacity-50">{loading ? "Loading…" : "Load more reports"}</button>
        </div>}
      </Panel>
    </div>
    <Drawer open={selected !== null} onClose={() => { setSelected(null); setArmed(null); }} title={selected ? `Report — ${selected.postTitle}` : "Report"}>
      {selected && <>
        <div className="bg-gradient-to-br from-[#9370DB] to-[#6b4fae] px-6 pb-6 pt-14 text-white">
          <p className="text-lg font-black">{selected.postTitle}</p>
          <p className="text-sm text-white/75">@{selected.creatorUsername} · {selected.reportCount} {selected.reportCount === 1 ? "report" : "reports"}</p>
        </div>
        <div className="space-y-5 px-6 py-5 text-sm text-zinc-900" onClick={() => setArmed(null)}>
          {selected.videoUrl ? <video controls preload="none" src={selected.videoUrl} poster={selected.posterUrl ?? undefined}
            className="max-h-72 w-full rounded-xl bg-black object-contain" aria-label={`Reported video: ${selected.postTitle}`} /> :
            <p className="rounded-xl border border-[#e9e3f7] p-4 text-gray-500">Video preview unavailable.</p>}
          <div className="rounded-xl border border-[#e9e3f7] p-4">
            <p className="flex items-center gap-2 font-semibold text-[#6b4fae]"><IconFlag size={14} />{reportReasonLabel(selected.reason)}</p>
            <p className="mt-2 whitespace-pre-wrap text-gray-600">{selected.details || "No additional details."}</p>
            <p className="mt-3 text-xs text-gray-400">Reported <TimeAgo iso={selected.createdAt} /> · Video {selected.postStatus}</p>
          </div>
          {selected.notificationStatus !== "sent" && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Moderation email {selected.notificationStatus === "failed" ? "failed" : "is pending"}. The report is saved here.
            <button type="button" disabled={busy} onClick={() => void retryAlert(selected)} className="ml-2 font-semibold underline disabled:opacity-50">Retry email</button>
          </div>}
          <div className="flex flex-wrap gap-2 border-t border-[#f0ebfb] pt-4">
            {selected.postStatus === "live" && <ActionButton variant="neutral" disabled={busy} onClick={() => void postAction("/api/admin/hide-post", { postId: selected.postId }, "Video hidden from public surfaces.")}><IconEyeOff size={13} />Hide</ActionButton>}
            {selected.postStatus !== "removed" && <ActionButton variant="danger" disabled={busy} armed={armed === "remove"}
              onClick={(event) => { event.stopPropagation(); if (armed === "remove") void postAction("/api/admin/remove-post", { postId: selected.postId }, "Video removed from public surfaces."); else setArmed("remove"); }}>
              <IconTrash size={13} />{armed === "remove" ? "Confirm remove" : "Remove"}
            </ActionButton>}
            {selected.creatorId && <ActionButton variant="danger" disabled={busy} armed={armed === "ban"}
              onClick={(event) => { event.stopPropagation(); if (armed === "ban") void postAction("/api/admin/ban", { userId: selected.creatorId! }, "Creator banned."); else setArmed("ban"); }}>
              {armed === "ban" ? "Confirm ban" : "Ban creator"}
            </ActionButton>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-[#f0ebfb] pt-4">
            {selected.status === "open" ? <>
              <ActionButton variant="approve" disabled={busy} onClick={() => void postAction(`/api/admin/reports/${selected.id}`, { status: "reviewed" }, "Report marked reviewed.")}><IconCheck size={13} />Mark reviewed</ActionButton>
              <ActionButton variant="neutral" disabled={busy} onClick={() => void postAction(`/api/admin/reports/${selected.id}`, { status: "dismissed" }, "Report dismissed.")}>Dismiss report</ActionButton>
            </> : <ActionButton variant="neutral" disabled={busy} onClick={() => void postAction(`/api/admin/reports/${selected.id}`, { status: "open" }, "Report reopened.")}>Reopen report</ActionButton>}
          </div>
        </div>
      </>}
    </Drawer>
  </>;
}
