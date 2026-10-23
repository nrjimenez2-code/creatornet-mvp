"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient, runMfaAction } from "@/lib/supabaseClient";
import { prepareSessionNavigation } from "@/lib/browserSession";
import { useUser } from "@/lib/useUser";
import { getActionSession } from "@/lib/actionSession";

type Factor = { id: string; friendly_name?: string; status: string };
type Status = { userId: string; verifiedFactorCount: number; aal2: boolean; recent: boolean };
type Enrollment = { id: string; qr: string; secret: string };
const client = () => createClient();

function PrivilegedMfaPanel({ userId }: { userId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [pendingFactors, setPendingFactors] = useState<Factor[]>([]);
  const [selected, setSelected] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/account/security", { cache: "no-store", credentials: "include" });
    if (!response.ok) {
      setStatus(null); setFactors([]); setPendingFactors([]);
      throw Error(response.status === 401 ? "Sign in again, then return to Account security." : "Account security is unavailable for this account. Try again after signing in.");
    }
    const next = await response.json() as Status;
    const { data, error: factorError } = await client().auth.mfa.listFactors();
    if (factorError) throw Error("Could not load your authenticators. Try again.");
    if (userId !== next.userId) throw Error("Your sign-in changed. Reload Account security.");
    const verified = data.totp.filter(factor => factor.status === "verified");
    setPendingFactors(data.all.filter(factor => factor.factor_type === "totp" && factor.status !== "verified"));
    setStatus(next); setFactors(verified); setSelected(previous => verified.some(factor => factor.id === previous) ? previous : verified[0]?.id ?? "");
    return next;
  }, [userId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(load).catch(() => { if (active) setError("Sign in and reload Account security to continue." ); });
    return () => { active = false; };
  }, [load]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const current = await getActionSession();
      if (current.error || !current.data.session || current.data.session.user.id !== userId) throw Error("Your sign-in changed. Reload Account security.");
      await runMfaAction(current.data.session.access_token, action);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not complete this request. Try again."); }
    finally { setBusy(false); }
  }
  async function checkCurrentAccount() {
    const { data, error: sessionError } = await getActionSession();
    if (sessionError || !status || data.session?.user.id !== status.userId) throw Error("Your sign-in changed. Reload Account security.");
  }
  async function enroll() {
    await checkCurrentAccount();
    const current = await load();
    if (current.verifiedFactorCount > 0 && (!current.aal2 || !current.recent)) throw Error("Verify an existing authenticator before adding a backup.");
    const listed = await client().auth.mfa.listFactors();
    if (listed.error || listed.data.all.some(factor => factor.factor_type === "totp" && factor.status !== "verified")) throw Error("Review and cancel the pending setup below before starting another.");
    if (!consent) throw Error("Confirm that you understand the effect on other signed-in devices.");
    const { data, error: enrollError } = await client().auth.mfa.enroll({ factorType: "totp", friendlyName: name.trim() || `Authenticator ${new Date().toISOString()}`, issuer: "CreatorNet" });
    if (enrollError || data.type !== "totp") {
      await load();
      throw Error("Authenticator setup did not finish. Review pending setups before trying again.");
    }
    setEnrollment({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }); setCode("");
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) { setError("Enter the complete six-digit authenticator code."); return; }
    await run(async () => {
      await checkCurrentAccount();
      const factorId = enrollment?.id ?? selected;
      if (!factorId || (enrollment && !consent)) throw Error("Select an authenticator and confirm setup before continuing.");
      const { error: verifyError } = await client().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      setCode("");
      if (verifyError?.code === "mfa_session_changed") { setEnrollment(null); throw Error("Your sign-in changed. Reload Account security before trying again."); }
      if (verifyError) {
        if (["session_not_found", "session_expired", "bad_jwt", "no_authorization", "refresh_token_not_found", "refresh_token_already_used"].includes(verifyError.code ?? "") || verifyError.name === "AuthSessionMissingError" || verifyError.status === 401) {
          setEnrollment(null); setStatus(null); setFactors([]); setPendingFactors([]); setSelected("");
          throw Error("This browser's sign-in is no longer valid. Sign in again, then verify your authenticator.");
        }
        if (verifyError.code === "over_request_rate_limit" || verifyError.status === 429) throw Error("Too many verification attempts. Wait a minute before trying again.");
        if (verifyError.code === "mfa_verification_failed") throw Error("That authenticator code was not accepted. Check the selected authenticator and your device time, then try again.");
        throw Error("Could not verify your authenticator. Reload Account security before trying again.");
      }
      // Clear the enrollment secret immediately; do not retain it if cookie
      // synchronization fails after the provider has already verified it.
      setEnrollment(null);
      if (!(await prepareSessionNavigation(client()))) throw Error("Sign in again to finish verifying this browser.");
      const current = await load();
      if (!current.aal2 || !current.recent) throw Error("Verification succeeded but this browser is not synchronized yet. Reload Account security.");
      setNotice("Authenticator verified. Administrator controls are ready. Add an independent backup authenticator before you need it.");
    });
  }
  async function cancelEnrollment() {
    await checkCurrentAccount();
    if (!enrollment) return;
    await cancelPending(enrollment.id);
    setEnrollment(null); setCode("");
  }
  async function cancelPending(id: string) {
    await checkCurrentAccount();
    const latest = await client().auth.mfa.listFactors();
    if (latest.error || !latest.data.all.some(factor => factor.id === id && factor.factor_type === "totp" && factor.status !== "verified")) throw Error("This setup changed. Reload before cancelling it.");
    const result = await client().auth.mfa.unenroll({ factorId: id });
    if (result.error) throw Error("Could not cancel the pending setup. Reload before trying again.");
    await load();
  }
  async function remove() {
    await checkCurrentAccount();
    const current = await load();
    const latest = await client().auth.mfa.listFactors();
    const verified = latest.data?.totp.filter(factor => factor.status === "verified") ?? [];
    if (latest.error || !current.aal2 || !current.recent || verified.length <= 1 || !verified.some(factor => factor.id === removeId)) throw Error("Verify an authenticator and keep at least one verified device before removing another.");
    const { error: removeError } = await client().auth.mfa.unenroll({ factorId: removeId! });
    if (removeError) throw Error("Could not remove this authenticator. Try verifying a remaining device first.");
    setRemoveId(null); await load(); setNotice("Authenticator removed. Keep your remaining device and backup secure.");
  }

  // Both replay providers must block the entire subtree, including img src
  // attributes: masking input text alone does not protect a setup QR secret.
  return <main className="mx-auto max-w-xl px-5 py-10 text-white sentry-block ph-no-capture" data-sentry-block data-ph-no-capture>
    <h1 className="text-2xl font-semibold">Account security</h1>
    <p className="mt-3">Use an authenticator for administrator controls. Your regular account, purchases and private site access remain available after ordinary sign-in.</p>
    {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
    {notice && <p role="status" className="mt-4 text-green-300">{notice}</p>}
    {!status && <div className="mt-5 flex gap-4"><Link href="/auth?next=%2Faccount%2Fsecurity">Sign in</Link><button onClick={() => void run(async () => { await load(); })} disabled={busy}>Retry</button></div>}
    {status && <>
      <p className="mt-4" role="status">{status.aal2 ? (status.recent ? "Verified for administrator controls." : "Verify again before making changes.") : (factors.length ? "Verify an authenticator to continue." : "Set up your first authenticator to continue.")}</p>
      {status.aal2 && <Link className="mt-3 inline-block underline" href="/admin">Return to administrator controls</Link>}
      {!enrollment && pendingFactors.length > 0 && <section className="mt-5"><h2 className="font-semibold">Unfinished setup</h2><p>Setup keys cannot be shown again. Cancel an unfinished setup before creating a replacement.</p>{pendingFactors.map(factor => <div key={factor.id} className="mt-2"><span>{factor.friendly_name || "Pending authenticator"}</span><button disabled={busy} className="ml-4 underline" onClick={() => void run(() => cancelPending(factor.id))}>Cancel unfinished setup</button></div>)}</section>}
      {factors.length > 0 && !enrollment && <label className="mt-5 block">Authenticator<select value={selected} onChange={event => setSelected(event.target.value)} className="mt-1 block w-full rounded bg-zinc-800 p-3">{factors.map(factor => <option key={factor.id} value={factor.id}>{factor.friendly_name || "Authenticator"}</option>)}</select></label>}
      {enrollment && <section className="mt-5" aria-label="New authenticator setup">
        <p>Scan this QR code with your authenticator app. Keep the setup key private.</p>
        {/* Provider-generated data URL, displayed as an inert image. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={enrollment.qr} alt="Authenticator setup QR code" width={240} height={240} className="mt-3 bg-white p-3" />
        <details className="mt-2"><summary>Enter setup key manually</summary><code className="break-all">{enrollment.secret}</code></details>
        <button className="mt-3 underline" disabled={busy} onClick={() => void run(cancelEnrollment)}>Cancel this pending setup</button>
      </section>}
      {(factors.length > 0 || enrollment) && <form onSubmit={verify} className="mt-5">
        <label>Six-digit authenticator code<input aria-label="Six-digit authenticator code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value)} className="mt-1 block w-full rounded bg-zinc-800 p-3" /></label>
        <button className="mt-3 rounded bg-purple-700 px-4 py-3" disabled={busy}>Verify authenticator</button>
      </form>}
      {!enrollment && <section className="mt-8 border-t border-zinc-700 pt-5">
        <h2 className="text-lg font-semibold">{factors.length ? "Add a backup authenticator" : "Set up an authenticator"}</h2>
        <p className="mt-2">Verifying a new authenticator signs out other signed-in devices. Complete any work there first. Store a backup on an independent device or in secure offline storage.</p>
        <label className="mt-3 block"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I understand the effect on other devices.</label>
        <label className="mt-3 block">Device name<input maxLength={60} value={name} onChange={event => setName(event.target.value)} className="mt-1 block w-full rounded bg-zinc-800 p-3" /></label>
        <button className="mt-3 rounded bg-purple-700 px-4 py-3" disabled={busy || !consent || pendingFactors.length > 0 || (!!factors.length && (!status.aal2 || !status.recent))} onClick={() => void run(enroll)}>Start authenticator setup</button>
      </section>}
      {factors.length > 0 && <section className="mt-8 border-t border-zinc-700 pt-5"><h2 className="text-lg font-semibold">Manage authenticators</h2>
        <p className="mt-2">Keep at least one verified authenticator. To replace your last device, add and verify its replacement first.</p>
        {factors.map(factor => <div key={factor.id} className="mt-3 flex items-center justify-between gap-3"><span>{factor.friendly_name || "Authenticator"}</span><button disabled={busy || factors.length <= 1 || !status.aal2 || !status.recent} onClick={() => setRemoveId(factor.id)} className="underline">Remove</button></div>)}
        {removeId && <div className="mt-3"><p>Remove this authenticator? Your other verified device will remain available.</p><button disabled={busy} onClick={() => void run(remove)} className="mr-4 underline">Confirm removal</button><button disabled={busy} onClick={() => setRemoveId(null)}>Keep it</button></div>}
      </section>}
    </>}
    <section className="mt-8 border-t border-zinc-700 pt-5"><h2 className="text-lg font-semibold">Lost your authenticator?</h2><p className="mt-2">Sign in normally and verify your backup authenticator here. If all devices are lost, account recovery requires identity verification with the trusted site operator. Email sign-in cannot reset your second factor. There is no automatic reset or recovery-code bypass.</p></section>
  </main>;
}

export default function PrivilegedMfa() {
  const { session, loading } = useUser();
  const userId = session?.user.id;
  if (loading) return <p role="status" className="p-6 text-white">Loading account security…</p>;
  if (!userId) return <main className="p-6 text-white"><h1>Account security</h1><Link href="/auth?next=%2Faccount%2Fsecurity">Sign in to continue</Link></main>;
  // A changed account unmounts all secrets and pending UI from the old account.
  return <PrivilegedMfaPanel key={userId} userId={userId} />;
}
