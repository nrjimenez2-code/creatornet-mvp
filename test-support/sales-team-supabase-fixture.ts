import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
const json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export function teamSupabaseFixture(db:PGlite):SupabaseClient{
 const rpc=async(name:string,args:Record<string,unknown>)=>{
  const keys=Object.keys(args);if(!/^[a-z_0-9]+$/.test(name)||keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error("Invalid fixture query");
  try{const r=await db.query<{r:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")}) r`,Object.values(args));return {data:json(r.rows[0].r),error:null};}catch(error){return {data:null,error};}
 };
 return {rpc,from:(table:string)=>{
  if(!/^[a-z_0-9]+$/.test(table))throw Error(table);let columns="*";const filters:Record<string,unknown>={};
  const chain={select:(value:string)=>{if(!/^[a-z_,*]+$/.test(value))throw Error(value);columns=value;return chain;},eq:(key:string,value:unknown)=>{if(!/^[a-z_]+$/.test(key))throw Error(key);filters[key]=value;return chain;},maybeSingle:async()=>{
   const r=await db.query(`select ${columns} from public.${table} where ${Object.keys(filters).map((k,i)=>`${k}=$${i+1}`).join(" and ")}`,Object.values(filters));return {data:r.rows[0]?json(r.rows[0]):null,error:null};}};return chain;
 }} as unknown as SupabaseClient;
}
