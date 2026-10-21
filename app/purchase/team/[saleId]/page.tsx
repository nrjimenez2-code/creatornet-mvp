import TeamBuyerReview from "@/components/TeamBuyerReview";
export const metadata={title:"Review your purchase · CreatorNet",referrer:"same-origin" as const};
export default async function TeamPurchaseReview({params}:{params:Promise<{saleId:string}>}){
 const {saleId}=await params;return <TeamBuyerReview saleId={saleId}/>;
}
