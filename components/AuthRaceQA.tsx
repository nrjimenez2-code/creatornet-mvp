"use client";

// Temporary Staging-only harness. Uses normal application APIs and current
// browser auth; never creates users, admits codes, or displays credentials.
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import { prepareSessionNavigation, signOutThisDevice, syncBrowserSession } from "@/lib/browserSession";

const prefix = "23602700-0000-4000-8000-00000000000";
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
type Check = { tag: string; offset: number; limit: number; ids: number[]; hasMore: boolean };
const checks: Check[] = [
  { tag: "cnqa_hashtag_20260927", offset: 0, limit: 2, ids: [8,7], hasMore: true },
  { tag: "cnqa_hashtag_20260927", offset: 2, limit: 2, ids: [6,5], hasMore: true },
  { tag: "cnqa_hashtag_20260927", offset: 4, limit: 2, ids: [4], hasMore: false },
  { tag: "cnqa_array_20260927", offset: 0, limit: 2, ids: [8,7], hasMore: true },
  { tag: "cnqa_array_20260927", offset: 2, limit: 2, ids: [6], hasMore: false },
  { tag: " #CNQA_ARRAY_20260927 ", offset: 0, limit: 3, ids: [8,7,6], hasMore: false },
  { tag: "cnqa_hashtag_2026092", offset: 0, limit: 2, ids: [], hasMore: false },
  { tag: " # ", offset: 0, limit: 2, ids: [], hasMore: false },
];

export default function AuthRaceQA() {
  const [status, setStatus] = useState("Ready");
  const [result, setResult] = useState<unknown>(null);
  const client = createClient();
  async function run(name: string, action: () => Promise<unknown>) {
    setStatus(name + " pending"); setResult(null);
    try { setResult(await action()); setStatus(name + " settled"); }
    catch (error) { setResult({ errorName: error instanceof Error ? error.name : "Error" }); setStatus(name + " failed"); }
  }
  async function currentState() {
    const { data, error } = await client.auth.getSession();
    const cookie = await fetch("/auth/callback", { credentials: "include", cache: "no-store" });
    const cookieResult = await cookie.json();
    return { browserHasSession: !!data.session, errorName: error?.name, serverHasUser: !!cookieResult.userId,
      sameUser: !!data.session && cookieResult.userId === data.session.user.id };
  }
  async function hashtagChecks() {
    const results = [];
    for (const check of checks) {
      const response = await fetch(`/api/tag/${encodeURIComponent(check.tag)}?offset=${check.offset}&limit=${check.limit}`, { credentials: "include", cache: "no-store" });
      const body = await response.json();
      const ids = Array.isArray(body.items) ? body.items.map((row: {id: string}) => row.id) : [];
      const expected = check.ids.map(id => prefix + id);
      const pass = response.ok && JSON.stringify(ids) === JSON.stringify(expected) && body.hasMore === check.hasMore && body.nextOffset === check.offset + ids.length;
      results.push({ query: check, status: response.status, ids, hasMore: body.hasMore, nextOffset: body.nextOffset, tag: body.tag, pass });
    }
    return { checkedAt: new Date().toISOString(), project: "nwqfofezfzljhxolkycz", pass: results.every(r => r.pass), results };
  }
  async function refresh() {
    const result = await client.auth.refreshSession();
    return { errorName: result.error?.name ?? null, status: result.error?.status, returnedSession: !!result.data.session, state: await currentState() };
  }
  async function signoutDuringRefresh() {
    const pendingRefresh = client.auth.refreshSession();
    await pause();
    await signOutThisDevice(client);
    const result = await pendingRefresh;
    return { errorName: result.error?.name ?? null, status: result.error?.status, state: await currentState() };
  }
  async function signoutDuringCallback() {
    const { data } = await client.auth.getSession();
    if (!data.session) return { needsSignIn: true };
    const pendingSync = syncBrowserSession(data.session, "SIGNED_IN", client);
    await pause();
    await signOutThisDevice(client);
    await pendingSync;
    return currentState();
  }
  const buttons: [string, () => Promise<unknown>][] = [
    ["Run hashtag API checks", hashtagChecks],
    ["Check email sign-in configuration", async () => {
      const response = await fetch("/api/auth/email-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { status: response.status, configurationUnavailable: response.status === 503, input: "empty body; no email or credentials supplied" };
    }],
    ["Read current auth state", currentState],
    ["Refresh current session once", refresh],
    ["Verify session navigation", async () => ({ verified: await prepareSessionNavigation(client), state: await currentState() })],
    ["Sign out this device", async () => { await signOutThisDevice(client); return currentState(); }],
    ["Test sign-out during refresh", signoutDuringRefresh],
    ["Test sign-out during cookie sync", signoutDuringCallback],
  ];
  return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">PR 236 Staging verification</h1>
    <p>Staging project nwqfofezfzljhxolkycz. Temporary controls use the current tab session and normal application APIs.</p>
    <p><Link href="/auth?authTrace=1">Normal email sign-in</Link> · <Link href="/?authTrace=1">Open feed</Link></p>
    <div className="flex flex-wrap gap-3">{buttons.map(([name, action]) => <button className="rounded border px-3 py-2" key={name} onClick={() => void run(name, action)}>{name}</button>)}</div>
    <p role="status">{status}</p>
    <pre className="overflow-auto whitespace-pre-wrap text-sm">{result ? JSON.stringify(result, null, 2) : "No result yet"}</pre>
  </main>;
}
