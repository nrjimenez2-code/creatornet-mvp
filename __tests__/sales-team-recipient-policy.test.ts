import {recipientCreationRequest,observeTeamRecipient,recipientLinkRequest,verifiedRecipientLink,type TeamRecipientSetup} from "@/lib/salesTeams/recipientPolicy";
const user="00000000-0000-4000-8000-000000000002",setupId="00000000-0000-4000-8000-000000000003";
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const setup:TeamRecipientSetup={user_id:user,id:setupId,api:"v2",account_id:"acct_original",legacy_creation_key:null,context,request:recipientCreationRequest(user,setupId,"member@example.test")};
function account(){return {id:"acct_original",object:"v2.core.account",livemode:false,metadata:{creatornet_user_id:user,creatornet_team_recipient_setup_id:setupId},
 identity:{country:"US"},defaults:{currency:"usd",responsibilities:{fees_collector:"application",losses_collector:"application"}},dashboard:"express",applied_configurations:["recipient"],
 configuration:{recipient:{applied:true,capabilities:{stripe_balance:{stripe_transfers:{status:"active"},payouts:{status:"pending"}}}}}};}
test("new recipient requests use server-owned frozen US/USD recipient parameters",()=>{
 expect(setup.request).toMatchObject({apiVersion:"2026-08-26.dahlia",path:"/v2/core/accounts",params:{contact_email:"member@example.test",identity:{country:"us"},dashboard:"express"}});
 expect(setup.request?.params).not.toHaveProperty("type");expect(setup.request?.params).not.toHaveProperty("merchant");
});
test("active transfers do not establish bank payout readiness",()=>{
 const object=account();expect(observeTeamRecipient(setup,object,"req_current")).toMatchObject({transfersActive:true,payoutsReady:false});
 object.configuration.recipient.capabilities.stripe_balance.payouts.status="active";
 expect(observeTeamRecipient(setup,object,"req_current").payoutsReady).toBe(true);
 object.configuration.recipient.applied=false;expect(observeTeamRecipient(setup,object,"req_current")).toMatchObject({transfersActive:false,payoutsReady:false});
});
test("nullable unrequested payout capability holds routing without losing the original identity",()=>{
 const object=account();Object.assign(object.configuration.recipient.capabilities.stripe_balance,{payouts:null});
 expect(observeTeamRecipient(setup,object,"req_current")).toMatchObject({accountId:"acct_original",transfersActive:true,payoutsReady:false});
});
test.each(["owner","setup","mode","account","platform","country","currency","responsibility","request","capability"])("recipient proof rejects mismatched %s",fault=>{
 const object=account();let proof="req_current";
 if(fault==="owner")object.metadata.creatornet_user_id=setupId;
 if(fault==="setup")object.metadata.creatornet_team_recipient_setup_id=user;
 if(fault==="mode")object.livemode=true;
 if(fault==="account")object.id="acct_other";
 if(fault==="platform")object.id=context.platformAccountId;
 if(fault==="country")object.identity.country="CA";
 if(fault==="currency")object.defaults.currency="cad";
 if(fault==="responsibility")object.defaults.responsibilities.losses_collector="stripe";
 if(fault==="request")proof="invented";
 if(fault==="capability")object.configuration.recipient.capabilities.stripe_balance.payouts.status="enabled";
 expect(()=>observeTeamRecipient(setup,object,proof)).toThrow();
});
test("legacy reuse verifies the original durable key and independent v1 capabilities",()=>{
 const legacy={...setup,api:"v1" as const,legacy_creation_key:setupId,request:null};
 const object={id:"acct_original",object:"account",country:"US",default_currency:"usd",payouts_enabled:false,capabilities:{transfers:"active"},metadata:{creatornet_user_id:user,creatornet_creation_id:setupId}};
 expect(observeTeamRecipient(legacy,object,"req_current")).toMatchObject({api:"v1",transfersActive:true,payoutsReady:false});
 object.metadata.creatornet_creation_id=user;expect(()=>observeTeamRecipient(legacy,object,"req_current")).toThrow();
});
test("hosted account links bind the original account and server return URLs without inventing an ID",()=>{
 const request=recipientLinkRequest(setup);expect(request.path).toBe("/v2/core/account_links");
 expect(request.params).toEqual({account:"acct_original",use_case:{type:"account_onboarding",account_onboarding:{configurations:["recipient"],refresh_url:context.siteOrigin+"/dashboard/closers/payouts?setup=refresh",return_url:context.siteOrigin+"/dashboard/closers/payouts?setup=return"}}});
 const now=Date.now(),link={object:"v2.core.account_link",account:"acct_original",livemode:false,url:"https://connect.stripe.com/setup/synthetic",expires_at:new Date(now+300000).toISOString()};
 expect(verifiedRecipientLink(setup,link,now)).toEqual({url:link.url,expiresAt:link.expires_at});
 for(const change of [{account:"acct_other"},{livemode:true},{url:"https://attacker.test/setup"},{expires_at:new Date(now-1).toISOString()}])expect(()=>verifiedRecipientLink(setup,{...link,...change},now)).toThrow();
});
