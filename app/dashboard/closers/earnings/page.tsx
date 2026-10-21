import {Suspense} from "react";
import SalesTeamStatements from "@/components/SalesTeamStatements";
export const metadata={title:"Commission statements · CreatorNet"};
export default function TeamStatementsPage(){return <Suspense fallback={<main aria-busy="true">Loading commission statements…</main>}><SalesTeamStatements/></Suspense>;}
