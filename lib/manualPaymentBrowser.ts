import type {ManualPaymentAction} from "./manualPaymentAction";

export type ManualPaymentScope={requestId:string;buyerId:string;productId:string;mode:"full"|"installments"|"monthly_first"|"monthly_payoff";amountCents:number;selectionId?:string};
export type SavedManualAction=Extract<ManualPaymentAction,{kind:"token"|"replacement"|"after_authentication"|"card"|"card_replacement"}>;
export const manualActionKey=(s:ManualPaymentScope)=>`creatornet:manual-payment-v1:${s.buyerId}:${s.mode}:${s.requestId}${s.mode==="monthly_payoff"?":"+s.selectionId:""}`;
const same=(a:ManualPaymentScope,b:ManualPaymentScope)=>a.requestId===b.requestId&&a.buyerId===b.buyerId&&a.productId===b.productId&&a.mode===b.mode&&a.amountCents===b.amountCents&&a.selectionId===b.selectionId;
function parse(value:any):SavedManualAction{
  const keys=value&&Object.keys(value).sort().join(",");
  if(value?.kind==="card"&&keys==="kind,paymentMethodId"&&/^pm_[A-Za-z0-9]{1,200}$/.test(value.paymentMethodId))return value;
  if(value?.kind==="card_replacement"&&keys==="kind,paymentMethodId,previousOperationId"&&/^pm_[A-Za-z0-9]{1,200}$/.test(value.paymentMethodId)&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.previousOperationId))return value;
  if(value?.kind==="token"&&keys==="kind,tokenId"&&/^ctoken_[A-Za-z0-9]{1,200}$/.test(value.tokenId))return value;
  if(["replacement","after_authentication"].includes(value?.kind)&&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.previousOperationId)&&
    (value.kind==="replacement"?keys==="kind,previousOperationId,tokenId"&&/^ctoken_[A-Za-z0-9]{1,200}$/.test(value.tokenId):keys==="kind,previousOperationId"))return value;
  throw Error("Your saved payment needs review.");
}
export function readManualAction(storage:Storage,s:ManualPaymentScope):SavedManualAction|null{
  const raw=storage.getItem(manualActionKey(s));if(!raw)return null;
  const value=JSON.parse(raw);if(value.version!==1||!value.scope||!same(value.scope,s))throw Error("Your saved payment needs review.");
  return parse(value.action);
}
export function saveManualAction(storage:Storage,s:ManualPaymentScope,action:SavedManualAction){
  // Persist BEFORE sending a payable action. Never save card/address/secret data.
  const raw=JSON.stringify({version:1,scope:s,action:parse(action)});
  storage.setItem(manualActionKey(s),raw);
  if(storage.getItem(manualActionKey(s))!==raw)throw Error("Could not save this payment. No confirmation was sent.");
}
export const manualPaymentEndpoint=(s:ManualPaymentScope)=>s.mode==="full"?`/api/checkout/manual/${s.requestId}`:
  s.mode==="monthly_first"?`/api/memberships/${s.requestId}/manual`:
  s.mode==="monthly_payoff"?`/api/memberships/${s.requestId}/manual-payoff`:`/api/installments/reservations/${s.requestId}/payment`;
/** Caller must first verify server release of this exact owner/request. */
export function clearReleasedManualSelection(storage:Storage,s:ManualPaymentScope){
  if(s.mode==="monthly_first"||s.mode==="monthly_payoff")return;
  const key=`creatornet:mentorship-${s.mode==="full"?"full-selection":"selection"}:${s.buyerId}:${s.productId}`;
  const raw=storage.getItem(key);if(!raw)return;const saved=JSON.parse(raw);
  if((s.mode==="full"?saved.manualRequestId:saved.request?.request_id)===s.requestId&&
    saved.quote?.terms?.buyerId===s.buyerId&&saved.quote?.terms?.productId===s.productId&&storage.getItem(key)===raw)storage.removeItem(key);
}
