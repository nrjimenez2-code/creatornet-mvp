import { requireReleaseOwner } from "@/lib/release/server";
import ReleaseControls from "@/components/admin/ReleaseControls";
import { readReleaseState } from "@/lib/release/management";
export const dynamic = "force-dynamic";
export default async function ReleasesPage() {
  const initial = await readReleaseState(await requireReleaseOwner());
  return <ReleaseControls initial={initial} />;
}
