export type BankReviewAction="acknowledged"|"escalated";
export type BankReviewScope={actor:string;creator:string;request:string};
export type BankReviewIntent=BankReviewScope&{version:1;reviewId:string;action:BankReviewAction;stateSha256:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const bankReviewStorageKey=(scope:BankReviewScope)=>`creatornet-bank-review:v1:${JSON.stringify([scope.actor,scope.creator,scope.request])}`;
export function readBankReviewIntent(raw:string|null,scope:BankReviewScope):BankReviewIntent|null{
 if(raw===null)return null;
 if(raw.length>2048)throw Error("A saved review request needs reconciliation before a new review.");
 let value:unknown;try{value=JSON.parse(raw);}catch{throw Error("A saved review request needs reconciliation before a new review.");}
 const v=value as BankReviewIntent;
 if(!v||typeof v!=="object"||Array.isArray(v)||v.version!==1||
  Object.keys(v).some(k=>!["version","actor","creator","request","reviewId","action","stateSha256"].includes(k))||
  ![v.actor,v.creator,v.request,v.reviewId].every(x=>typeof x==="string"&&uuid.test(x))||
  v.actor!==scope.actor||v.creator!==scope.creator||v.request!==scope.request||
  !["acknowledged","escalated"].includes(v.action)||typeof v.stateSha256!=="string"||!/^[a-f0-9]{64}$/.test(v.stateSha256))
  throw Error("A saved review request needs reconciliation before a new review.");
 return v;
}
export const bankReviewBody=(v:BankReviewIntent)=>({creator_id:v.creator,request_id:v.request,review_id:v.reviewId,action:v.action,state_sha256:v.stateSha256});
export function bankReviewResultMatches(value:unknown,intent:BankReviewIntent){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).every(k=>["reviewId","recorded","bankConfirmed","outstanding"].includes(k))&&v.reviewId===intent.reviewId&&
  typeof v.recorded==="boolean"&&v.bankConfirmed===false&&v.outstanding===true;
}
