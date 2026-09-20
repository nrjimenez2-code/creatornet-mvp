"use client";

import { useEffect } from "react";
import { useUser } from "@/lib/useUser";
import { connectSoundAccount } from "@/lib/audioPreference";
import { createSoundAccount } from "@/lib/soundAccount";

export default function SoundPreferenceSync() {
  const { session, userId, loading } = useUser();
  const token = session?.access_token;
  useEffect(() => {
    if (loading) return;
    return connectSoundAccount(userId && token ? createSoundAccount(userId, token) : null);
  }, [loading, userId, token]);
  return null;
}
