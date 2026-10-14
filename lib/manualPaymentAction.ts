import "server-only";
import {assertAgreementId} from "./installments/agreementStore";

export type ManualPaymentAction={kind:"card";paymentMethodId:string}|{kind:"card_replacement";paymentMethodId:string;previousOperationId:string}|{kind:"prepare"}|{kind:"observe"}|{kind:"stop"}|{kind:"token";tokenId:string}|
  {kind:"replacement";tokenId:string;previousOperationId:string}|{kind:"after_authentication";previousOperationId:string}|
  {kind:"authenticate";operationId:string};

/** Only action intent crosses HTTP. Owner, order, amount and provider payment
 * identities are always loaded from the authenticated buyer's saved selection. */
export function parseManualPaymentAction(value:any):ManualPaymentAction {
  if(!value||Array.isArray(value))throw Error("Invalid original payment action");
  const shapes:Record<string,string>={card:"kind,paymentMethodId",card_replacement:"kind,paymentMethodId,previousOperationId",prepare:"kind",observe:"kind",stop:"kind",token:"kind,tokenId",
    replacement:"kind,previousOperationId,tokenId",after_authentication:"kind,previousOperationId",authenticate:"kind,operationId"};
  if(!Object.hasOwn(shapes,value.kind)||Object.keys(value).sort().join(",")!==shapes[value.kind])throw Error("Invalid original payment action");
  if("tokenId" in value&&(typeof value.tokenId!=="string"||!/^ctoken_[A-Za-z0-9]{1,200}$/.test(value.tokenId)))throw Error("Invalid original payment token");
  if("paymentMethodId" in value&&(typeof value.paymentMethodId!=="string"||!/^pm_[A-Za-z0-9]{1,200}$/.test(value.paymentMethodId)))throw Error("Invalid original payment method");
  if("previousOperationId" in value)assertAgreementId(value.previousOperationId);
  if("operationId" in value)assertAgreementId(value.operationId);
  return value;
}
