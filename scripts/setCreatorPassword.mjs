import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const newPassword = process.argv[2];
if (!newPassword) {
  console.error("Usage: node scripts/setCreatorPassword.mjs <newPassword>");
  process.exit(1);
}

const CREATOR_USER_ID = "da446e1e-6e2e-442b-9ec8-fc9b2a20ff94"; // creator@test.com

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function main() {
  const { data, error } = await admin.auth.admin.updateUserById(CREATOR_USER_ID, {
    password: newPassword,
  });

  if (error) {
    console.error("Failed to update password:", error.message);
    process.exit(1);
  }

  console.log("Password updated for creator@test.com");
  if (data?.user?.last_sign_in_at) {
    console.log("Last sign-in:", data.user.last_sign_in_at);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


