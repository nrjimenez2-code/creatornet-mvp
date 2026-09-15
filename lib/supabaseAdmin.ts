// lib/supabaseAdmin.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { timedDatabaseFetch } from './discoverDatabaseTiming';

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server only!
  { auth: { persistSession: false }, global: { fetch: timedDatabaseFetch } }
);
