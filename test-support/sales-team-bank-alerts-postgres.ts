import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {signedSurplusDatabase} from "./sales-team-surplus-ingress-postgres";
export const bankAlertMigrations=["20261029171329_sales_team_daily_surplus.sql","20261029182136_sales_team_beneficiary_payout_observations.sql",
 "20261029233544_sales_team_payout_statements.sql","20261031201235_sales_team_bank_exception_reviews.sql","20261104185509_sales_team_bank_exception_queue.sql",
 "20261104200116_sales_team_bank_review_actions.sql","20261104202340_sales_team_bank_review_action_contract.sql","20261104205001_sales_team_bank_alerts.sql"];
export async function bankAlertDatabase(db:PGlite){await signedSurplusDatabase(db);for(const name of bankAlertMigrations)await db.exec(readFileSync("supabase/migrations/"+name,"utf8"));}
