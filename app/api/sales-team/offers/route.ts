import { NextRequest } from "next/server";
import { approvedTeamInstallments,teamId,teamSaleSchemaReady,teamBookedOfferSchemaReady,TeamSalesError } from "@/lib/salesTeams/policy";
import { requireCloserReady,teamAccess,teamError,teamJson,teamRequest,teamRpc } from "@/lib/salesTeams/server";

export async function GET(req:NextRequest){
 try{
  if(!teamSaleSchemaReady())throw new TeamSalesError("TEAM_SALES_NOT_ENABLED","Approved team offers are not enabled.",404);
  const {admin,user}=await teamRequest(req),creator=teamId(req.nextUrl.searchParams.get("creator_id"));
  const {role,member}=await teamAccess(admin,creator,user.id);const bookingId=req.nextUrl.searchParams.get("booking_id");
  if(teamBookedOfferSchemaReady()){
   if(bookingId)teamId(bookingId);
   return teamJson(await teamRpc(admin,"read_sales_team_offer_catalog_v2",{p_creator_id:creator,p_actor_id:user.id,p_booking_id:bookingId}));
  }
  let allowedProduct:string|null=null;
  if(role==="closer"||bookingId){
   if(role==="closer")await requireCloserReady(admin,member);teamId(bookingId);
   const booking=await admin.from("bookings").select("id,post_id").eq("id",bookingId).eq("creator_id",creator).maybeSingle();
   if(booking.error||!booking.data)throw new TeamSalesError("BOOKING_UNAVAILABLE","This booking is unavailable.",404);
   if(role==="closer"){
    const assignment=await admin.from("sales_team_assignments_v1").select("booking_id").eq("booking_id",bookingId).eq("membership_id",member!.id).maybeSingle();
    if(assignment.error||!assignment.data)throw new TeamSalesError("BOOKING_UNAVAILABLE","This booking is not assigned to you.",403);
   }
   const post=await admin.from("posts").select("product_id").eq("id",booking.data.post_id).eq("creator_id",creator).eq("allow_booking",true).maybeSingle();
   if(post.error||!post.data?.product_id)throw new TeamSalesError("BOOKED_OFFER_REQUIRED","The booking needs an attached offer.");
   allowedProduct=post.data.product_id;
  }
  const [products,posts,approvals]=await Promise.all([
   admin.from("products").select("id,product_id,title,type,amount_cents,price_cents,currency,membership_terms,fixed_service_months").eq("creator_id",creator).eq("is_active",true).limit(200),
   admin.from("posts").select("product_id").eq("creator_id",creator).eq("allow_booking",true).limit(500),
   admin.from("sales_team_offer_approvals_v1").select("id,product_id,revision,amount_cents").eq("creator_id",creator).is("revoked_at",null).limit(200),
  ]);
  for(const result of [products,posts,approvals])if(result.error)throw result.error;
  const attached=new Set((posts.data||[]).map(p=>p.product_id));
  const offers=(products.data||[]).filter(p=>(attached.has(p.id)||attached.has(p.product_id))&&(!allowedProduct||p.id===allowedProduct||p.product_id===allowedProduct));
  const relevant=(approvals.data||[]).filter(a=>offers.some(p=>p.id===a.product_id));
  const options=relevant.length?await admin.from("sales_team_offer_options_v1").select("id,approval_id,product_id,kind,payment_count").eq("creator_id",creator).in("approval_id",relevant.map(a=>a.id)):{data:[],error:null};
  if(options.error)throw options.error;await teamAccess(admin,creator,user.id);
  return teamJson({offers,approvals:relevant,options:options.data||[]});
 }catch(error){return teamError(error);}
}
export async function POST(req:NextRequest){
 try{
  if(!teamSaleSchemaReady())throw new TeamSalesError("TEAM_SALES_NOT_ENABLED","Approved team offers are not enabled.",404);
  const {admin,user}=await teamRequest(req,true),body=await req.json();
  const creator=teamId(body.creator_id),product=teamId(body.product_id),requestId=teamId(body.request_id);
  const access=await teamAccess(admin,creator,user.id);
  if(access.role==="closer")throw new TeamSalesError("TEAM_MANAGER_REQUIRED","Only the creator or a manager approves prices and payment plans.",403);
  if(!Number.isSafeInteger(body.amount_cents)||body.amount_cents<50||body.amount_cents>99999999)
   throw new TeamSalesError("INVALID_SALES_PRICE","Choose an approved USD price of at least $0.50.",400);
  const counts=approvedTeamInstallments(body.installment_counts,body.amount_cents);
  const result=await teamRpc(admin,"configure_sales_team_offer_v1",{p_creator_id:creator,p_actor_id:user.id,p_product_id:product,
   p_request_id:requestId,p_amount_cents:body.amount_cents,p_counts:counts});
  return teamJson(result);
 }catch(error){return teamError(error);}
}
