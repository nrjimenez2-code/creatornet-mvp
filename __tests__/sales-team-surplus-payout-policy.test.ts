import {teamSurplusPayoutFixture} from "@/test-support/sales-team-surplus-payout-fixture";
import {inspectTeamSurplusDestination,inspectTeamSurplusPayout,inspectTeamSurplusBalance,reconcileTeamSurplusPayout} from "@/lib/salesTeams/surplusPayoutPolicy";

test("fresh payout eligibility checks the approved owned bank and manual settings without retaining bank details",()=>{
 const f=teamSurplusPayoutFixture(),proof=inspectTeamSurplusDestination(f.q,f.account,f.settings,f.bank);
 expect(proof).toMatchObject({destinationId:"ba_approved",country:"US",currency:"usd",manualPayouts:true,payoutsEnabled:true});expect(proof.bankHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(proof)).not.toContain("fp_bank_fixture");
});
test.each(["account","country","currency","disabled","automatic","bank","bank_country","bank_currency","bank_status","customer","fingerprint","automatic_rule"])("fresh %s mismatch cannot authorize a payout",fault=>{
 const f=teamSurplusPayoutFixture();
 if(fault==="account")f.account.id="acct_foreign";
 if(fault==="country")f.account.country="CA";
 if(fault==="currency")f.account.default_currency="cad";
 if(fault==="disabled")f.account.payouts_enabled=false;
 if(fault==="automatic")f.settings.payments!.payouts!.schedule!.interval="daily";
 if(fault==="bank")f.bank.id="ba_foreign";
 if(fault==="bank_country")f.bank.country="CA";
 if(fault==="bank_currency")f.bank.currency="cad";
 if(fault==="bank_status")f.bank.status="errored";
 if(fault==="customer")f.bank.customer="cus_foreign";
 if(fault==="fingerprint")f.bank.fingerprint="";
 if(fault==="automatic_rule")Object.assign(f.settings.payments!.payouts!,{automatic_transfer_rules_by_currency:{usd:[{type:"transfer_all",payout_method:"fa_foreign"}]}});
 expect(()=>inspectTeamSurplusDestination(f.q,f.account,f.settings,f.bank)).toThrow(/payout evidence requires review/);
});

test.each(["pending","in_transit","paid"])("provider %s with an independent debit remains separate from bank confirmation",status=>{
 const f=teamSurplusPayoutFixture();f.payout.status=status;const payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now),debit=inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now);
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,null,f.now)).toMatchObject({complete:true,disposition:"debit_observed",costCents:0,bankConfirmed:false});
});

test.each(["id","amount","mode","currency","source","destination","instant","automatic","metadata","created","reversal"])("original payout %s mismatch cannot be accounted as this request",fault=>{
 const f=teamSurplusPayoutFixture();
 if(fault==="id")f.payout.id="po_foreign";
 if(fault==="amount")f.payout.amount++;
 if(fault==="mode")f.payout.livemode=true;
 if(fault==="currency")f.payout.currency="cad";
 if(fault==="source")f.payout.source_type="bank_account";
 if(fault==="destination")f.payout.destination="ba_foreign";
 if(fault==="instant")f.payout.method="instant";
 if(fault==="automatic")f.payout.automatic=true;
 if(fault==="metadata")f.payout.metadata={team_protocol:"foreign"};
 if(fault==="created")f.payout.created=f.now-60;
 if(fault==="reversal")f.payout.reversed_by="po_reversal";
 expect(()=>inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now)).toThrow(/payout evidence requires review/);
});

test.each(["source","amount","type","category","net","fee_sum","request","currency","balance_type","exchange"])("a debit's %s must independently match the original payout",fault=>{
 const f=teamSurplusPayoutFixture(),payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now);
 if(fault==="source")f.debit.source="po_foreign";
 if(fault==="amount")f.debit.amount=-4999;
 if(fault==="type")f.debit.type="transfer";
 if(fault==="category")f.debit.reporting_category="transfer";
 if(fault==="net")f.debit.net++;
 if(fault==="fee_sum"){f.debit.fee=2;f.debit.net=-5002;}
 if(fault==="request")f.debit.lastResponse.requestId="foreign";
 if(fault==="currency")f.debit.currency="cad";
 if(fault==="balance_type")f.debit.balance_type="issuing";
 if(fault==="exchange")f.debit.exchange_rate=1;
 expect(()=>inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now)).toThrow(/payout evidence requires review/);
});

test.each(["failed","canceled"])("%s requires the exact independently available return before releasing its original",status=>{
 const f=teamSurplusPayoutFixture();f.payout.status=status;f.payout.failure_balance_transaction="txn_return";f.returned.type=status==="failed"?"payout_failure":"payout_cancel";
 const payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now),debit=inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now),returned=inspectTeamSurplusBalance(f.q,payout,f.returned,"return",f.now);
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,{...returned,status:"pending"},f.now)).toMatchObject({complete:false,disposition:null,bankConfirmed:false});
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,returned,f.now)).toMatchObject({complete:true,disposition:"returned",bankConfirmed:false});
});

test("failed status without a returned-funds reference does not release principal",()=>{
 const f=teamSurplusPayoutFixture();f.payout.status="failed";const payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now),debit=inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now);
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,null,f.now)).toMatchObject({complete:false,disposition:null,bankConfirmed:false});
});

test("actual fee excess preserves the observed debit and reports reserve review separately",()=>{
 const f=teamSurplusPayoutFixture();f.debit.fee=30;f.debit.net=-5030;f.debit.fee_details=[{amount:30,currency:"usd",application:null,type:"stripe_fee",description:"Synthetic payout cost"}];
 const payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now),debit=inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now);
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,null,f.now)).toMatchObject({complete:true,costCents:30,costReserveExceeded:true,bankConfirmed:false});
});

test("current bank disable does not erase an independently observed original debit",()=>{
 const f=teamSurplusPayoutFixture();f.bank.status="errored";f.account.payouts_enabled=false;
 expect(()=>inspectTeamSurplusDestination(f.q,f.account,f.settings,f.bank)).toThrow();
 const payout=inspectTeamSurplusPayout(f.q,f.payout,"po_original",f.now),debit=inspectTeamSurplusBalance(f.q,payout,f.debit,"debit",f.now);
 expect(reconcileTeamSurplusPayout(f.q,payout,debit,null,f.now)).toMatchObject({complete:true,bankConfirmed:false});
});
