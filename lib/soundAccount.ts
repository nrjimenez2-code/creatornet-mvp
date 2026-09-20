import { SOUND_ACCOUNT_FIELD, type SoundAccount } from "@/lib/audioPreference";

/** Capture the owning session's token so a delayed save cannot target a new
 * account after sign-out. This is preference data, never authorization data.
 * Uses Supabase Auth's /user API without a service role or schema change.
 */
export function createSoundAccount(id: string, accessToken: string): SoundAccount {
  const request = async (soundOn?: boolean) => {
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      method: soundOn === undefined ? "GET" : "PUT",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      ...(soundOn === undefined ? {} : { body: JSON.stringify({ data: { [SOUND_ACCOUNT_FIELD]: soundOn } }) }),
    });
    if (!response.ok) throw new Error("Sound preference sync failed");
    const user = await response.json();
    if (user.id !== id) throw new Error("Sound preference account mismatch");
    const saved = user.user_metadata?.[SOUND_ACCOUNT_FIELD];
    return typeof saved === "boolean" ? saved : undefined;
  };
  return {
    id,
    load: () => request(),
    save: async (soundOn) => {
      if (await request(soundOn) !== soundOn) throw new Error("Sound preference was not saved");
    },
  };
}
