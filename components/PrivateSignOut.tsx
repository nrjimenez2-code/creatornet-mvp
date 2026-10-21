"use client";
import { createClient } from "@/lib/supabaseClient";
export default function PrivateSignOut() {
  return <button className="underline" onClick={async () => { await createClient().auth.signOut(); window.location.replace("/"); }}>Sign out</button>;
}
