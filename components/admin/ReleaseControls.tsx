"use client";
import { useCallback, useState } from "react";
import { FEATURES, dependenciesMet, type Feature, type ReleaseSettings } from "@/lib/release/policy";
type State = { settings: ReleaseSettings; testers: Array<{ user_id: string; approved_at: string }>; audit: Array<{ id: string; action: string; target_id: string; reason: string; created_at: string }> };
export default function ReleaseControls({ initial }: { initial: State }) {
  const [state, setState] = useState<State>(initial);
  const [draft, setDraft] = useState<ReleaseSettings>(initial.settings);
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/releases", { cache: "no-store" });
    if (!response.ok) throw new Error("Release Controls could not load. Try reloading.");
    const result: State = await response.json();
    setState(result); setDraft(result.settings);
  }, []);
  async function save(body: object, testers = false) {
    if (busy || !state) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(testers ? "/api/admin/releases/testers" : "/api/admin/releases", { method: testers ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, revision: state.settings.revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Update failed. Reload to check the current state.");
      await load(); setMessage("Changes saved."); setUserId("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Update failed. Reload before trying again."); }
    finally { setBusy(false); }
  }
  const inputClass = "rounded-lg border border-gray-300 bg-white p-3 disabled:opacity-50";
  return <section className="space-y-8">
    <header><h1 className="text-3xl font-bold">Release Controls</h1><p className="mt-2 text-gray-600">Choose what opens to the public. Scheduling and release dates are deferred.</p></header>
    {message && <p role="status" className="rounded-lg border bg-white p-4">{message}</p>}
    <button type="button" className="underline" disabled={busy} onClick={() => load().catch(error => setMessage(error.message))}>Reload current settings</button>
    {draft && state && <>
      <section className="rounded-xl border bg-white p-6"><h2 className="text-xl font-bold">Public website: {state.settings.hidden ? "Hidden" : "Feature controls active"}</h2><p className="my-3">Hide website closes public product access and preserves the saved feature choices. Approved private access and existing purchase support remain available.</p>
        <button type="button" disabled={busy || state.settings.hidden} className="rounded-lg bg-zinc-900 px-5 py-3 text-white disabled:opacity-50" onClick={() => save({ hidden: true, features: state.settings.features, discordInvite: state.settings.discord_invite })}>Hide website now</button>
      </section>
      <form className="space-y-6 rounded-xl border bg-white p-6" onSubmit={event => { event.preventDefault(); save({ hidden: draft.hidden, features: draft.features, discordInvite: draft.discord_invite }); }}>
        <label className="block font-semibold">Discord invite<input type="url" required className={`${inputClass} mt-2 block w-full`} value={draft.discord_invite ?? ""} onChange={event => setDraft({ ...draft, discord_invite: event.target.value })} disabled={busy} /></label>
        <label className="flex gap-3"><input type="checkbox" checked={draft.hidden} disabled={busy} onChange={event => setDraft({ ...draft, hidden: event.target.checked })} />Hide website</label>
        <fieldset disabled={busy} className="space-y-4"><legend className="mb-4 text-xl font-bold">Public feature access</legend>
          {(Object.keys(FEATURES) as Feature[]).map(key => <label key={key} className="flex gap-3"><input type="checkbox" checked={draft.features[key]} onChange={event => setDraft({ ...draft, features: { ...draft.features, [key]: event.target.checked } })} /><span>{FEATURES[key].label}<small className="block text-gray-500">{FEATURES[key].requires.length ? `Requires: ${FEATURES[key].requires.map(dependency => FEATURES[dependency].label).join(", ")}` : "No release dependencies"}</small></span></label>)}
        </fieldset>
        {!dependenciesMet(draft.features) && <p role="alert">Enable the required dependencies, or close the dependent feature.</p>}
        <button disabled={busy || !dependenciesMet(draft.features)} className="rounded-lg bg-[#7952b3] px-5 py-3 text-white disabled:opacity-50">{busy ? "Saving…" : "Save release settings"}</button>
      </form>
      <section className="space-y-4 rounded-xl border bg-white p-6"><h2 className="text-xl font-bold">Approved testers</h2><p>Use an existing verified account ID. Approval does not grant administration or release management.</p>
        <form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); save({ userId: userId.trim(), approved: true }, true); }}><label className="sr-only" htmlFor="tester-account">Existing account ID</label><input id="tester-account" required value={userId} onChange={event => setUserId(event.target.value)} disabled={busy} placeholder="Existing account UUID" className={`${inputClass} flex-1`} /><button disabled={busy} className="underline">Approve tester</button></form>
        {state.testers.length === 0 && <p>No testers are approved.</p>}
        <ul className="space-y-3">{state.testers.map(tester => <li key={tester.user_id} className="flex flex-wrap justify-between gap-3"><span className="break-all font-mono text-sm">{tester.user_id}</span><button disabled={busy} className="underline" onClick={() => save({ userId: tester.user_id, approved: false }, true)}>Revoke access</button></li>)}</ul>
      </section>
      <section className="rounded-xl border bg-white p-6"><h2 className="mb-4 text-xl font-bold">Recent access changes</h2><ul className="space-y-4">{state.audit.map(entry => <li key={entry.id}><p>{entry.created_at} · {entry.action}</p><details><summary className="cursor-pointer underline">Change details</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{entry.target_id}{"\n"}{entry.reason}</pre></details></li>)}</ul></section>
    </>}
  </section>;
}
