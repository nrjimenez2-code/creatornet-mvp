import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { BIO_LIMIT, bioMentions, mentionCandidates, USERNAME_PATTERN, type MentionAccount, type MentionResolution } from "@/lib/profileBio";

const PUBLIC_IDENTITY = "id, username, full_name, avatar_url";
const MAX_CANDIDATES = 400;
const RESULT_LIMIT = 801;
const escapeLike = (value: string) => value.replace(/[_%\\]/g, "\\$&");

async function lookupMentionAccounts(names: string[]): Promise<MentionResolution> {
  const empty = { accounts: [], ambiguousNames: [] };
  const distinct = [...new Set(names.map(name => name.toLowerCase()))];
  if (!distinct.length || distinct.length > MAX_CANDIDATES || distinct.some(name => !USERNAME_PATTERN.test(name))) return empty;
  try {
    const { data, error } = await supabaseAdmin.from("profiles").select(PUBLIC_IDENTITY)
      .is("banned_at", null)
      .or(distinct.map(name => `username.ilike.${escapeLike(name)}`).join(","))
      .limit(RESULT_LIMIT);
    if (error || !data || data.length >= RESULT_LIMIT) return empty;
    const counts = new Map<string, number>();
    for (const row of data) counts.set(row.username.toLowerCase(), (counts.get(row.username.toLowerCase()) ?? 0) + 1);
    return {
      accounts: data.filter(row => counts.get(row.username.toLowerCase()) === 1 && distinct.includes(row.username.toLowerCase())),
      ambiguousNames: distinct.filter(name => (counts.get(name) ?? 0) > 1),
    };
  } catch { return empty; }
}

export async function resolveMentionAccounts(names: string[]): Promise<MentionAccount[]> {
  return (await lookupMentionAccounts(names)).accounts;
}

export async function resolveBioMentions(bio: string): Promise<MentionResolution> {
  return lookupMentionAccounts(bioMentions(bio.slice(0, BIO_LIMIT)).flatMap(token => mentionCandidates(token.username)));
}

export async function suggestMentionAccounts(query: string): Promise<MentionAccount[]> {
  const prefix = escapeLike(query);
  const { data, error } = await supabaseAdmin.from("profiles").select(PUBLIC_IDENTITY)
    .is("banned_at", null).or(`username.ilike.${prefix}%,full_name.ilike.${prefix}%`)
    .order("username").limit(5);
  if (error) throw error;
  const candidates = (data ?? []).filter(row => USERNAME_PATTERN.test(row.username ?? "") && !!row.username?.trim());
  // Suggestions must also avoid usernames which would resolve ambiguously on display.
  const resolved = await resolveMentionAccounts(candidates.map(row => row.username));
  const ids = new Set(resolved.map(row => row.id));
  return candidates.filter(row => ids.has(row.id));
}
