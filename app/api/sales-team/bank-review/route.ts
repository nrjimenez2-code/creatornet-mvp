import {NextRequest} from "next/server";
import {teamId,teamBankReviewSchemaReady,teamBankReviewReady,teamBankReviewActionsSchemaReady,teamBankReviewActionsReady,TeamSalesError} from "@/lib/salesTeams/policy";
import {teamError,teamJson,teamRequest,teamRpc} from "@/lib/salesTeams/server";

function errorResponse(error:unknown){
 const message=String((error as {message?:string})?.message||"");
 const codes:Record<string,{message:string;status:number}>={
  BANK_REVIEW_ACCESS_DENIED:{message:"This payout review is unavailable to your account.",status:403},
  TEAM_STATEMENT_ACCESS_DENIED:{message:"This payout review is unavailable to your account.",status:403},
  BANK_REVIEW_STATE_CHANGED:{message:"The payout observation changed. Refresh before recording a new review.",status:409},
  BANK_REVIEW_ACTION_STATE_CHANGED:{message:"The payout observation changed and this review was not recorded. Refresh before recording a new review.",status:409},
  BANK_REVIEW_ACTION_ISOLATION_REQUIRED:{message:"Recording this review requires transaction reconciliation. Keep the original request.",status:409},
  BANK_REVIEW_ACTION_AUTHORITY_REQUIRED:{message:"Recording this review is held pending contract reconciliation. Keep the original request.",status:409},
  ORIGINAL_BANK_REVIEW_REQUIRED:{message:"Resume the original review request.",status:409},
  BANK_REVIEW_AUTHORITY_REQUIRED:{message:"Recording payout reviews is currently held.",status:409},
  INVALID_BANK_REVIEW_CURSOR:{message:"Refresh the payout review history.",status:400}
 };
 const code=Object.keys(codes).find(key=>message.includes(key));
 return code?teamJson({code,error:codes[code].message},codes[code].status):teamError(error);
}

export async function GET(req:NextRequest){
 try{
  if(!teamBankReviewSchemaReady())throw new TeamSalesError("BANK_REVIEW_NOT_ENABLED","Payout review history is not available yet.",404);
  const {admin,user}=await teamRequest(req),cursor=req.nextUrl.searchParams.get("cursor");
  const result=await teamRpc<Record<string,unknown>>(admin,teamBankReviewActionsSchemaReady()?"read_sales_team_bank_review_view_v1":"read_sales_team_bank_exception_v1",{
   p_creator_id:teamId(req.nextUrl.searchParams.get("creator_id")),p_actor_id:user.id,
   p_request_id:teamId(req.nextUrl.searchParams.get("request_id")),p_cursor:cursor?teamId(cursor):null,p_limit:20
  });
  return teamJson({...result,canReview:teamBankReviewActionsReady()&&result.canReview===true});
 }catch(error){return errorResponse(error);}
}

export async function POST(req:NextRequest){
 try{
  if(!teamBankReviewReady())throw new TeamSalesError("BANK_REVIEW_HELD","Recording payout reviews is currently held.");
  if(req.headers.get("origin")!==new URL(req.url).origin)throw new TeamSalesError("SAME_ORIGIN_REQUIRED","Use this CreatorNet page to record a review.",403);
  // Historical review does not require new-sales admission. Authentication and
  // the SQL owner's current creator/manager authorization still apply.
  const {admin,user}=await teamRequest(req);
  const raw=await req.text();
  if(raw.length>4096)throw new TeamSalesError("INVALID_BANK_REVIEW","Use a bounded review request.",400);
  let body:unknown;
  try{body=JSON.parse(raw);}catch{throw new TeamSalesError("INVALID_BANK_REVIEW","Use a valid review request.",400);}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new TeamSalesError("INVALID_BANK_REVIEW","Refresh this payout before reviewing it.",400);
  const input=body as Record<string,unknown>;
  if(Object.keys(input).some(key=>!["creator_id","request_id","review_id","action","state_sha256"].includes(key))||
   !["acknowledged","escalated"].includes(String(input.action))||typeof input.state_sha256!=="string"||!/^[a-f0-9]{64}$/.test(input.state_sha256))
   throw new TeamSalesError("INVALID_BANK_REVIEW","Choose an acknowledgement or escalation for the current payout observation.",400);
  return teamJson(await teamRpc(admin,teamBankReviewActionsSchemaReady()?"record_sales_team_bank_review_action_v1":"record_sales_team_bank_exception_review_v1",{
   p_review_id:teamId(input.review_id),p_creator_id:teamId(input.creator_id),p_actor_id:user.id,
   p_request_id:teamId(input.request_id),p_action:input.action,p_state_sha256:input.state_sha256
  }));
 }catch(error){return errorResponse(error);}
}
