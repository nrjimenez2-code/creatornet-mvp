/** Bound both concurrency and newly started work; always await every started operation. */
export async function runSchedulingBatch(next:()=>Promise<{processed:boolean;retry?:boolean}>,
 options:{concurrency:number;maxAttempts:number;budgetMs:number;now?:()=>number}){
 const now=options.now??Date.now,deadline=now()+options.budgetMs;
 let attempts=0,processed=0,retries=0,failed=false;
 const lane=async()=>{
  while(now()<deadline && attempts<options.maxAttempts){
   attempts++;
   try{const result=await next();if(!result.processed)return;processed++;if(result.retry)retries++;}
   catch{failed=true;return;}
  }
 };
 await Promise.all(Array.from({length:options.concurrency},lane));
 return {processed,retries,failed};
}
