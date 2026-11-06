import "server-only";
import type {ManualPaymentAction} from "./manualPaymentAction";

/** Used by the full and installment manual action routes. Other ingress and
 * collection paths need their own admission controls before maintenance. */
export function manualPaymentAdmissionPaused(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED==="true";
}

/** Recovery still resolves the owner's original payment and operation through
 * the existing route/runtime checks. New action kinds are paused by default. */
export function isManualPaymentRecoveryAction(action:ManualPaymentAction):boolean {
  switch(action.kind){
    case "observe":
    case "stop":
    case "authenticate":
    case "after_authentication":
      return true;
    default:
      return false;
  }
}
