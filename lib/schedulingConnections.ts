import "server-only";
import { randomUUID, randomBytes } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingConfig, schedulingOrigin } from "@/lib/schedulingConfig";
import { openSchedulingSecret, sealSchedulingSecret } from "@/lib/schedulingSecrets";
import { createSchedulingWebhook, deleteSchedulingWebhook, exchangeSchedulingToken,
  getSchedulingAccount, listSchedulingEventTypes, listSchedulingWebhooks, SchedulingProviderError,
  schedulingApi,
  type SchedulingProvider, type SchedulingTokens, type SchedulingAccount } from "@/lib/schedulingProvider";

type Connection = {
  id: string; creator_id: string; provider: SchedulingProvider; status: string;
  account_id: string | null; account_name: string | null; organization_id: string | null;
  credentials_ciphertext: string | null; webhook_id: string | null; webhook_secret_ciphertext: string | null;
  lease_id: string; token_expires_at: string | null;
};

async function checked(result: { error: unknown }) { if (result.error) throw new Error("Could not save booking connection"); }
const context = (row: Connection, purpose: string) => `${row.creator_id}:${row.provider}:${purpose}`;

async function withConnection<T>(creator: string, provider: SchedulingProvider, action: (row: Connection) => Promise<T>): Promise<T> {
  await checked(await db.from("scheduling_connections_v1").upsert({ creator_id: creator, provider }, { onConflict: "creator_id,provider", ignoreDuplicates: true }));
  const lease = randomUUID();
  const now = new Date().toISOString();
  const { data, error } = await db.from("scheduling_connections_v1")
    .update({ lease_id: lease, lease_until: new Date(Date.now() + 10 * 60_000).toISOString() })
    .eq("creator_id", creator).eq("provider", provider).or(`lease_until.is.null,lease_until.lt.${now}`)
    .select("*").maybeSingle();
  if (error) throw new Error("Could not lock booking connection");
  if (!data) throw new Error("Another connection update is in progress. Try again shortly.");
  const row = data as Connection;
  try { return await action(row); }
  finally {
    await db.from("scheduling_connections_v1").update({ lease_id: null, lease_until: null }).eq("id", row.id).eq("lease_id", lease);
  }
}

async function save(row: Connection, values: Record<string, unknown>) {
  const { data, error } = await db.from("scheduling_connections_v1")
    .update({ ...values, updated_at: new Date().toISOString() }).eq("id", row.id).eq("lease_id", row.lease_id)
    .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
  if (error || !data) throw new Error("Could not save booking connection");
  Object.assign(row, values);
}

async function saveTokens(row: Connection, tokens: SchedulingTokens) {
  await save(row, { credentials_ciphertext: sealSchedulingSecret(JSON.stringify(tokens), context(row, "tokens")), token_expires_at: new Date(tokens.expiresAt).toISOString() });
}

async function accessToken(row: Connection, forceRefresh = false): Promise<string> {
  if (!row.credentials_ciphertext) throw new Error("Connect your booking provider first");
  const stored = JSON.parse(openSchedulingSecret(row.credentials_ciphertext, context(row, "tokens"))) as SchedulingTokens;
  if (!forceRefresh && stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
  try {
    // The database lease serializes single-use refresh-token rotation across instances.
    const fresh = await exchangeSchedulingToken(row.provider, schedulingConfig(row.provider), { refreshToken: stored.refreshToken });
    await saveTokens(row, fresh);
    return fresh.accessToken;
  } catch (error) {
    if (error instanceof SchedulingProviderError && (error.status === 400 || error.status === 401))
      await save(row, { status: "reconnect_required", last_error_code: "authorization_expired" });
    throw error;
  }
}

async function withSchedulingAccess<T>(row: Connection, action: (token: string) => Promise<T>): Promise<T> {
  const token = await accessToken(row);
  try { return await action(token); }
  catch (error) {
    if (!(error instanceof SchedulingProviderError) || !error.requiresReconnect) throw error;
    // Provider rejection can precede the saved expiry. Keep rotation under the
    // existing connection lease and retry once before asking the creator to reconnect.
    const fresh = await accessToken(row, true);
    try { return await action(fresh); }
    catch (retryError) {
      if (retryError instanceof SchedulingProviderError && retryError.requiresReconnect)
        await save(row, { status: "reconnect_required", last_error_code: "authorization_expired" });
      throw retryError;
    }
  }
}

function accountFromRow(row: Connection): SchedulingAccount {
  if (!row.account_id) throw new Error("Missing booking account");
  return { id: row.account_id, name: row.account_name ?? "", organization: row.organization_id ?? undefined };
}

async function provision(row: Connection, token: string, account: SchedulingAccount) {
  const callback = `${schedulingOrigin()}/api/scheduling/${row.id}`;
  const secret = row.webhook_secret_ciphertext
    ? openSchedulingSecret(row.webhook_secret_ciphertext, context(row, "webhook"))
    : row.provider === "calcom" ? randomBytes(32).toString("hex") : process.env.CALENDLY_WEBHOOK_SIGNING_KEY!;
  // Persist the secret before the external mutation, enabling reconciliation after a timeout.
  await save(row, { webhook_secret_ciphertext: sealSchedulingSecret(secret, context(row, "webhook")) });
  const hooks = (await listSchedulingWebhooks(row.provider, token, account)).filter(hook => hook.callbackUrl === callback);
  const required = row.provider === "calcom" ? ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"] : ["invitee.created", "invitee.canceled"];
  const valid = hooks.find(hook => hook.active && required.every(event => hook.events.includes(event)) && (row.provider !== "calcom" || hook.secret === secret));
  for (const hook of hooks) if (hook.id !== valid?.id) await deleteSchedulingWebhook(row.provider, token, hook.id);
  const webhookId = valid?.id ?? await createSchedulingWebhook(row.provider, token, account, callback, secret);
  await save(row, { webhook_id: webhookId });
  const events = await listSchedulingEventTypes(row.provider, token, account);
  await checked(await db.from("scheduling_event_types_v1").update({ active: false }).eq("connection_id", row.id));
  if (events.length) await checked(await db.from("scheduling_event_types_v1").upsert(events.map(event => ({
    connection_id: row.id, provider_event_id: event.id, title: event.title, booking_url: event.bookingUrl, active: true, updated_at: new Date().toISOString(),
  })), { onConflict: "connection_id,provider_event_id" }));
  await save(row, { status: "connected", last_checked_at: new Date().toISOString(), last_error_code: null });
}

export async function finishSchedulingConnection(creator: string, provider: SchedulingProvider, code: string, verifier: string) {
  return withConnection(creator, provider, async row => {
    const tokens = await exchangeSchedulingToken(provider, schedulingConfig(provider), { code, verifier });
    const account = await getSchedulingAccount(provider, tokens.accessToken);
    if (row.account_id && row.account_id !== account.id && row.status !== "disconnected")
      throw new Error("Disconnect the previous account before connecting a different account");
    await save(row, { status: "pending", account_id: account.id, account_name: account.name, organization_id: account.organization ?? null });
    await saveTokens(row, tokens);
    try { await provision(row, tokens.accessToken, account); }
    catch (error) { await save(row, { status: "error", last_error_code: "setup_incomplete" }); throw error; }
  });
}

export async function refreshSchedulingConnection(creator: string, provider: SchedulingProvider) {
  return withConnection(creator, provider, async row => {
    if (row.status === "disconnected" || row.status === "disconnecting" || row.status === "reconnect_required" || !row.credentials_ciphertext) return;
    try {
      await withSchedulingAccess(row, async token => {
        const account = await getSchedulingAccount(provider, token);
        if (account.id !== row.account_id) throw new Error("Booking account changed");
        await provision(row, token, account);
      });
    } catch (error) {
      if (error instanceof SchedulingProviderError && error.requiresReconnect)
        await save(row, { status: "reconnect_required", last_error_code: "authorization_expired" });
      throw error;
    }
  });
}

export async function disconnectSchedulingConnection(creator: string, provider: SchedulingProvider) {
  return withConnection(creator, provider, async row => {
    if (row.status === "disconnected") return;
    // Immediately stop accepting callbacks, even if remote cleanup needs a retry.
    await save(row, { status: "disconnecting" });
    if (row.credentials_ciphertext && row.account_id) {
      const callback = `${schedulingOrigin()}/api/scheduling/${row.id}`;
      await withSchedulingAccess(row, async token => {
        // Re-list on retry: a previous attempt may already have removed some
        // hooks before authorization failed. Only remove this connection's hooks.
        const hooks = await listSchedulingWebhooks(provider, token, accountFromRow(row));
        for (const hook of hooks) if (hook.callbackUrl === callback) await deleteSchedulingWebhook(provider, token, hook.id);
      });
    }
    await checked(await db.from("scheduling_event_types_v1").update({ active: false }).eq("connection_id", row.id));
    await save(row, { status: "disconnected", credentials_ciphertext: null, webhook_id: null,
      webhook_secret_ciphertext: null, token_expires_at: null, last_error_code: null });
  });
}

export async function hydrateCalendlyEvent(creator: string, uri: string) {
  const url = new URL(uri);
  if (url.origin !== "https://api.calendly.com" || url.username || url.password || url.search || url.hash ||
      !/^\/scheduled_events\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error("Invalid scheduled event");
  return withConnection(creator, "calendly", async row => {
    if (row.status !== "connected") throw new Error("Booking provider is not connected");
    const result = await withSchedulingAccess(row, token => schedulingApi("calendly", token, url.pathname));
    if (!result.resource?.event_memberships?.some((member: { user: string }) => member.user === row.account_id))
      throw new Error("Scheduled event owner mismatch");
    return result.resource;
  });
}
