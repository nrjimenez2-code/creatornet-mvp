import { redirect } from "next/navigation";

/**
 * Public profile at /profile/:username.
 * The canonical creator experience lives on /creators/...; we keep a single source of truth there.
 */
export default async function ProfileByUsernamePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  if (!username) {
    redirect("/dashboard");
  }
  redirect(`/creators/${encodeURIComponent(username)}`);
}
