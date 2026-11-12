import {Suspense} from "react";
import SalesTeamBankAlerts from "@/components/SalesTeamBankAlerts";
export const metadata={title:"Payout alerts · CreatorNet"};
export default function BankAlertsPage(){return <Suspense fallback={<main aria-busy="true">Loading payout alerts…</main>}><SalesTeamBankAlerts/></Suspense>;}
