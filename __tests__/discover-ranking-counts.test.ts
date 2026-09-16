import {createHash} from 'node:crypto';
import {rankDiscover, type DiscoverEvent, type DiscoverEvidence, type DiscoverPlacement} from '@/lib/discoverRanking';
const now=Date.parse('2026-09-16T03:00:00Z');
// Fixed full-order/placement digests from fb687dd, before remaining-count optimization.
// Mixed creators, seen-state, dismissal, topics, offer types, evidence and control ordering.
function fixture(seed: number,count: number,creators: number): Parameters<typeof rankDiscover>{
 let state=seed;const random=(n: number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state>>>8)%n;};
 const categories=['business & entrepreneurship','education & career skills','money & investing','health & fitness'];
 const posts=Array.from({length:count},(_,i)=>({id:'p'+String(i).padStart(5,'0'),creator_id:'c'+random(creators),created_at:new Date(now-random(60)*86400000).toISOString(),interests:[categories[random(4)]],topics:[['ecommerce','languages','coding','marketing'][random(4)]],offer_type:['none','product','free_call','mentorship'][random(4)]}));
 const events: DiscoverEvent[]=[],evidence: DiscoverEvidence[]=[];
 for(const p of posts){
  for(let k=0,n=random(5);k<n;k++)events.push({actor:random(4)?'viewer':'other',post_id:p.id,kind:['exposure','quick_skip','like','not_interested','purchase','completion'][random(6)],categories:p.interests,topics:p.topics,audience:'general',offer_type:p.offer_type,occurred_at:new Date(now-random(100)*86400000).toISOString()});
  evidence.push({post_id:p.id,audience:'',exposures:random(60),sales:random(10),bookings:random(10),intents:random(10),taps:random(20),views:random(30),commercial:random(10),last_exposure:new Date(now-random(30)*86400000).toISOString()});
 }
 return [posts,events,'viewer',[categories[random(4)]],seed%3?['languages']:[],now,[],seed%2?evidence:undefined];
}
const oracles=[{"seed":1,"digest":"5c4b8bd14a6fbd1762026553bdb74a944ff42f4e851651aecf9b723618cbee7c"},{"seed":2,"digest":"f36ce399ca3ebbed5fe9fcd74a1787f242bbcc9ec46e41b8ca6d09eef16e41c6"},{"seed":3,"digest":"a6ef0d3f080750bf7b01d418797e65ee6d0d604806e6a1857d7584cb33875751"},{"seed":4,"digest":"a6d5e263d15ca21089032df57020c008f4293cfb3d15eaba688f1875fbbaac8f"},{"seed":5,"digest":"ede94b92e600a1b94b9267ae88f48ddfc15401b2c9f82ec640316984154d7072"},{"seed":6,"digest":"dec3dbdf1bc9ae18892fa154e41444ad16c4ab36dd1b413e85f3241b910a559d"},{"seed":7,"digest":"d77bf794ecfd11a0510db5fec7d9aa727506ba58f6213f9b1a52136d40c726d4"},{"seed":8,"digest":"4208591e04bd29f99f46605478a91572fab9c6501d186efb7be78efd12ac3218"},{"seed":19,"digest":"f21e717cf201ca5a12c7a6d0ac340373c1ab2cb382440c21649fbcdea325d31c"},{"seed":20,"digest":"d592ee58330399018e4a680dfd355281d72c6a935c937e34bf1810acecf70d9e"},{"seed":40,"digest":"563c416804ef7821f02b674e86ddfa83416f792a39b236e880247fce2684a253"},{"seed":41,"digest":"535ed800c8c836c67fcfffca6f836f95f7b657a06df794a40b00a9ca94a4baeb"}];
test.each(oracles)('preserves the pre-optimization ranking and placements for seed $seed', ({seed,digest})=>{
 const args=fixture(seed,40,[1,2,5,40][seed%4]);
 const placements: Record<string,DiscoverPlacement>={};
 args[8]={commercialOrdering:seed%3!==0,onPlacement:(id,value)=>{placements[id]=value;}};
 const ids=rankDiscover(...args);
 expect(createHash('sha256').update(JSON.stringify({ids,placements})).digest('hex')).toBe(digest);
});
