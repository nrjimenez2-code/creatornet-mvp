import "server-only";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {readTeamBeneficiaryPayout,type TeamBeneficiaryPayoutSource} from "./beneficiaryPayoutReadback";
import type {TeamReceiptComposition} from "./receipts";

type Admission={status:"admitted";checkId:string;leaseToken:string;source:TeamBeneficiaryPayoutSource;bankConfirmed:false}|
 {status:"busy"|"consumed";bankConfirmed:false};
type Recorded={status:"recorded";requestId:string;checkId:string;recorded:boolean;bankConfirmed:false};

/** Service-only bridge. Identifiers locate an original; database admission owns
 * the source. An uncertain completion is never replaced with bank confirmation.
 * No scheduler, user endpoint, financial POST or new-money authority is added. */
export async function observeTeamBeneficiaryPayout(c:TeamReceiptComposition,input:{checkId:string;requestId:string;payoutId:string}){
 const args=snapshotProviderJson(input),context=snapshotProviderJson(c.context);
 teamId(args.checkId);teamId(args.requestId);
 if(!/^po_[A-Za-z0-9]+$/.test(args.payoutId))throw Error("An original payout locator is required");
 const admin=c.admin,stripe=c.stripe,observe=c.observeContext.bind(c);
 let admittedAt:number|null=null;
 const bounded=()=>{if(admittedAt!==null&&(Date.now()<admittedAt||Date.now()-admittedAt>=85000))throw Error("Beneficiary observation deadline reached");};
 const current=async()=>{
  bounded();if(admittedAt!==null&&Date.now()-admittedAt>=50000)throw Error("Beneficiary context allowance exhausted");
  if(!isDeepStrictEqual(snapshotProviderJson(await observe()),context))throw Error("Beneficiary observation context changed");bounded();return context;
 };
 const rpc=async<T>(name:string,extra:Record<string,unknown>):Promise<T>=>{
  await current();const query=admin.rpc(name,{p_context:context,...extra});
  const result=await(typeof query.abortSignal==="function"?query.abortSignal(AbortSignal.timeout(5000)):query);
  bounded();if(result.error)throw result.error;return result.data as T;
 };
 const begun=await rpc<Admission>("begin_sales_team_beneficiary_payout_check_v1",{p_check_id:args.checkId,p_request_id:args.requestId,p_payout_id:args.payoutId});
 if(begun.bankConfirmed!==false||!["admitted","busy","consumed"].includes(begun.status))throw Error("Beneficiary admission changed");
 if(begun.status!=="admitted")return begun;
 admittedAt=Date.now();teamId(begun.leaseToken);
 if(begun.checkId!==args.checkId||begun.source.request.id!==args.requestId||!isDeepStrictEqual(begun.source.request.context,context))throw Error("Beneficiary source changed");
 const proof=await readTeamBeneficiaryPayout({context,observeContext:current,stripe},begun.source,args.payoutId);
 const result=await rpc<Recorded>("complete_sales_team_beneficiary_payout_check_v1",{p_check_id:args.checkId,p_lease_token:begun.leaseToken,p_proof:proof});
 if(result.status!=="recorded"||result.requestId!==args.requestId||result.checkId!==args.checkId||result.bankConfirmed!==false||typeof result.recorded!=="boolean")throw Error("Beneficiary completion changed");
 return result;
}
