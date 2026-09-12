import { completeBankVerification, completeContextBankVerification } from "../lib/installments/bankVerificationClient";
import { loadStripe } from "@stripe/stripe-js/pure";
jest.mock("@stripe/stripe-js/pure",()=>({loadStripe:jest.fn()}));
const load=jest.mocked(loadStripe),handleNextAction=jest.fn(),confirmPayment=jest.fn();
beforeEach(()=>{jest.clearAllMocks();load.mockResolvedValue({handleNextAction,confirmPayment} as never);});
test.each(["test", "live"] as const)("context %s mode uses only the original intent SDK action and returns no paid claim", async mode => {
  handleNextAction.mockResolvedValueOnce({paymentIntent:{status:"succeeded",client_secret:"SYNTHETIC"}});
  expect(await completeContextBankVerification(`pk_${mode}_SYNTHETIC`, "pi_fixture_secret_SYNTHETIC", mode)).toBeUndefined();
  expect(handleNextAction).toHaveBeenCalledWith({clientSecret:"pi_fixture_secret_SYNTHETIC"}); expect(confirmPayment).not.toHaveBeenCalled();
});
test.each([["pk_test_SYNTHETIC", "live"], ["pk_live_SYNTHETIC", "test"]] as const)("context key %s must match expected %s mode", async(key,mode)=>{
  await expect(completeContextBankVerification(key,"pi_fixture_secret_SYNTHETIC",mode)).rejects.toThrow("Bank verification unavailable"); expect(load).not.toHaveBeenCalled();
});
test("only Stripe handleNextAction is used for the existing intent",async()=>{
  await completeBankVerification("pk_test_SYNTHETIC","pi_fixture_secret_SYNTHETIC");
  expect(handleNextAction).toHaveBeenCalledWith({clientSecret:"pi_fixture_secret_SYNTHETIC"});expect(confirmPayment).not.toHaveBeenCalled();
});
test.each(["canceled","succeeded","throws","no SDK"])("%s returns no raw bank result or paid claim",async(status)=>{
  if(status==="throws")handleNextAction.mockRejectedValueOnce(new Error("SECRET"));
  else if(status==="no SDK")load.mockResolvedValueOnce(null);
  else handleNextAction.mockResolvedValueOnce(status==="canceled"?{error:{message:"SECRET"}}:{paymentIntent:{status:"succeeded",client_secret:"SECRET"}});
  expect(await completeBankVerification("pk_test_SYNTHETIC","pi_fixture_secret_SYNTHETIC")).toBeUndefined();expect(confirmPayment).not.toHaveBeenCalled();
});
test.each([["pk_live_INVALID","pi_fixture_secret_SYNTHETIC"],["pk_test_SYNTHETIC","invalid"],["pk_test_SYNTHETIC","https://invalid.test"]])
("rejects an invalid or live capability before loading Stripe",async(key,secret)=>{
  await expect(completeBankVerification(key,secret)).rejects.toThrow("Bank verification unavailable");expect(load).not.toHaveBeenCalled();
});
