import { Suspense } from "react";
import SalesTeamDashboard from "@/components/SalesTeamDashboard";

export const metadata = { title:"Sales team · CreatorNet", referrer:"same-origin" as const };
export default function SalesTeamPage(){
 return <Suspense fallback={<main aria-busy="true">Loading your sales team…</main>}><SalesTeamDashboard /></Suspense>;
}
