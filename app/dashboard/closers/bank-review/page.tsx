import {Suspense} from "react";
import SalesTeamBankExceptions from "@/components/SalesTeamBankExceptions";
export const metadata={title:"Payout review history · CreatorNet"};
export default function BankReviewPage(){return <Suspense fallback={<main aria-busy="true">Loading payout review history…</main>}><SalesTeamBankExceptions/></Suspense>;}
