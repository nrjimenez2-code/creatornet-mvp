import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {teamId} from "./policy";
import {recoverTeamAdmittedRefund,type TeamAdminRefundRequest,type TeamRefundRecoveryAuthority} from "./adminRefunds";
import {readTeamFinancialSnapshot,type TeamEventSource} from "./financialReadback";
import type {TeamReceiptComposition} from "./receipts";

/** Supplied run/token/task authority observes existing originals only. Each
 * phase revalidates the current worker; the original human remains approval
 * history and is never supplied as the worker's current admin identity. */
export async function recoverTeamWorkerRefund(c:TeamReceiptComposition,scope:{runId:string;leaseToken:string;taskId:string;requestId:string}){
 for(const value of [scope.runId,scope.leaseToken,scope.taskId,scope.requestId])teamId(value);
 const phase=async<T>(name:string,payload:Record<string,unknown>={}):Promise<T>=>{
  if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Refund recovery context changed");
  const request=c.admin.rpc("run_sales_team_worker_refund_recovery_v1",{p_run_id:scope.runId,p_lease_token:scope.leaseToken,p_context:c.context,p_task_id:scope.taskId,p_phase:name,p_payload:payload});
  const result=await (typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);
  if(result.error)throw result.error;return result.data as T;
 };
 type Check={checkId:string;completed:boolean;held:boolean;source:TeamEventSource};
 const begin=()=>phase<Check>("begin_check",{checkId:randomUUID()});
 const authority:TeamRefundRecoveryAuthority={
  read:async()=>{const q=await phase<TeamAdminRefundRequest>("read");if(q.id!==scope.requestId||!isDeepStrictEqual(q.context,c.context))throw Error("Original refund task changed");return q;},
  beginCheck:async()=>(await begin()).checkId,
  inspect:async(_receiptId,checkId)=>{
   const begun=checkId?await phase<Check>("begin_check",{checkId}):await begin();
   if(begun.completed)return {checkId:begun.checkId};
   const inspected=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});
   await phase("complete_check",{checkId:begun.checkId,revision:inspected.revision,snapshot:inspected.snapshot});
   return {checkId:begun.checkId};
  },
  recordRecovery:proof=>phase("event",{proof}),
  recordResult:proof=>phase<TeamAdminRefundRequest>("result",{proof}),
  responsibility:()=>phase("responsibility"),resolveCash:()=>phase("cash")
 };
 const view=await recoverTeamAdmittedRefund(c,authority);
 const status=await phase<{held:boolean}>("status");
 return {...view,held:status.held};
}
