import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: "creator@test.com",
    options: {
      redirectTo: "http://localhost:3000/auth",
    },
  });

  if (error) {
    console.error("Failed to generate magic link:", error.message);
    process.exit(1);
  }

  if (!data?.properties?.action_link) {
    console.error("Magic link not returned.");
    process.exit(1);
  }

  console.log("Magic link for creator@test.com:");
  console.log(data.properties.action_link);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


