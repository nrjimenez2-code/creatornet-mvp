import {runSchedulingBatch} from '@/lib/googleSchedulingBatch';
beforeEach(()=>{jest.useFakeTimers().setSystemTime(0);});afterEach(()=>jest.useRealTimers());
test('a 120-request burst uses three bounded batches with at most four operations in flight',async()=>{
 let remaining=120,active=0,peak=0,done=0;
 const next=async()=>{if(!remaining)return {processed:false};remaining--;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,100));active--;done++;return {processed:true};};
 for(let i=0;i<3;i++){const result=runSchedulingBatch(next,{concurrency:4,maxAttempts:40,budgetMs:60000});await jest.runAllTimersAsync();expect(await result).toEqual({processed:40,retries:0,failed:false});}
 expect(done).toBe(120);expect(remaining).toBe(0);expect(active).toBe(0);expect(peak).toBe(4);
});
test('slow provider calls stop new claims at the time budget and all started work is awaited',async()=>{
 let done=0;const next=async()=>{await new Promise(resolve=>setTimeout(resolve,10000));done++;return {processed:true};};
 const result=runSchedulingBatch(next,{concurrency:4,maxAttempts:40,budgetMs:60000});await jest.runAllTimersAsync();expect(await result).toEqual({processed:24,retries:0,failed:false});expect(done).toBe(24);expect(Date.now()).toBe(60000);
});
test('one failed lane does not discard work already running in the other lanes',async()=>{
 let calls=0;const next=async()=>{const id=++calls;if(id===1)throw new Error('database unavailable');await new Promise(resolve=>setTimeout(resolve,10));return {processed:true,retry:id===2};};
 const result=runSchedulingBatch(next,{concurrency:4,maxAttempts:8,budgetMs:60000});await jest.runAllTimersAsync();expect(await result).toEqual({processed:7,retries:1,failed:true});
});
