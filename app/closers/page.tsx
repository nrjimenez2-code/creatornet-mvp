// app/closers/page.tsx
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import ClosersClient, { CloserRow } from "@/components/ClosersClient";

export default async function ClosersPage() {
  // SSR Supabase with cookie adapter (works in Edge/Node runtimes)
  const jar = await cookies();
  const cookieAdapter: any = {
    get: (n: string) => jar.get(n)?.value,
    set: (n: string, v: string, o?: any) => jar.set(n, v, o as any),
    remove: (n: string, o?: any) => jar.set(n, "", { ...(o || {}), maxAge: 0 }),
  };

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: cookieAdapter }
  );

  const { data: auth } = await supabase.auth.getUser();
  const user = auth?.user ?? null;

  let initialRows: CloserRow[] = [];
  if (user) {
    const { data } = await supabase
      .from("closers")
      .select("id,name,booking_url,weight,active")
      .eq("creator_id", user.id)
      .order("weight", { ascending: true });

    initialRows = (data ?? []).map((r: any) => ({
      id: String(r.id),
      name: (r.name ?? "").toString(),
      booking_url: (r.booking_url ?? "").toString(),
      weight: Number.isFinite(r.weight) ? Number(r.weight) : 1,
      active: !!r.active,
    }));
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold mb-6">Closers</h1>

      {!user && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          You must be signed in.{" "}
          <a className="underline" href="/auth">
            Go to sign in.
          </a>
        </div>
      )}

      <ClosersClient userId={user?.id ?? null} initialRows={initialRows} />
    </main>
  );
}
