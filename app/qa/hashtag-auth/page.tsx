import { notFound } from "next/navigation";
import AuthRaceQA from "@/components/AuthRaceQA";

export const dynamic = "force-dynamic";

export default function Page() {
  if (process.env.VERCEL_ENV !== "preview" || process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://nwqfofezfzljhxolkycz.supabase.co") notFound();
  return <AuthRaceQA />;
}
