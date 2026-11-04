"use client";
import { useCallback } from "react";
import { useUser } from "@/lib/useUser";

export class TeamApiError extends Error{
 constructor(message:string,public readonly code:string|undefined,public readonly status:number){super(message);this.name="TeamApiError";}
}

export function useTeamApi(){
 const {session}=useUser(),token=session?.access_token;
 return useCallback(async(path:string,body?:Record<string,unknown>,signal?:AbortSignal)=>{
  const response=await fetch(path,{method:body?"POST":"GET",credentials:"include",signal,
   headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new TeamApiError(data.error||"This operation needs review.",typeof data.code==="string"?data.code:undefined,response.status);return data;
 },[token]);
}
