"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function OAuthCallback() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/dashboard");
      else router.replace("/auth");
    });
  }, [router]);

  return <p className="p-6 text-sm text-gray-500">Finishing sign in…</p>;
}
