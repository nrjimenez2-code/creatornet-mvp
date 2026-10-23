import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ExactPaymentContext} from "@/lib/installments/paymentContext";
import {teamId} from "./policy";
import {readSharedCashOriginal,type SharedCashOriginal} from "./sharedCashReadback";

type Composition=Parameters<typeof readSharedCashOriginal>[0]&{admin:SupabaseClient};
type Authority={actorId:string;workerRunId?:never}|{actorId?:never;workerRunId:string};
type CheckResult={checkId:string;completed:boolean;held:boolean};
/** Supplied composition only: no credential factory, global client, provider
 * writes or dispatcher. Persist the check ID before retrying an uncertain call.
 * A completed check is replayed from SQL without another provider observation. */
export async function inspectSharedCashOriginal(c:Composition,args:Authority&{kind:SharedCashOriginal["kind"];id:string;checkId?:string}):Promise<CheckResult>{
 const checkId=teamId(args.checkId??randomUUID()),actor=args.actorId??null,worker=args.workerRunId??null;
 if((actor===null)===(worker===null))throw Error("Shared cash reader authority required");
 if(actor)teamId(actor);if(worker)teamId(worker);
 if(args.kind==="legacy_refund")teamId(args.id);
 else if(args.kind!=="tip_restoration"||!/^dp_[A-Za-z0-9]{1,100}$/.test(args.id))throw Error("Original shared cash source required");
 const context:ExactPaymentContext=c.context;
 const current=async()=>{if(!isDeepStrictEqual(await c.observeContext(),context))throw Error("Shared cash context changed");};
 const rpc=async<T>(name:string,payload:Record<string,unknown>):Promise<T>=>{
  const {data,error}=await c.admin.rpc(name,payload);if(error)throw error;return data as T;
 };
 await current();
 const begun=await rpc<CheckResult&{source:SharedCashOriginal}>("begin_sales_team_shared_cash_check_v1",{
  p_check_id:checkId,p_source_kind:args.kind,p_source_id:args.id,p_actor_id:actor,p_worker_run_id:worker,p_context:context});
 if(begun.checkId!==checkId)throw Error("Original shared cash check changed");
 if(begun.completed)return {checkId,completed:true,held:begun.held};
 if(begun.source.kind!==args.kind||begun.source.id!==args.id||!isDeepStrictEqual(begun.source.context,context))throw Error("Original shared cash source changed");
 const proof=await readSharedCashOriginal(c,begun.source);
 await current();
 return rpc<CheckResult>("complete_sales_team_shared_cash_check_v1",{p_check_id:checkId,p_actor_id:actor,p_worker_run_id:worker,p_proof:proof});
}
