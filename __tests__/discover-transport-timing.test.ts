import { channel } from 'node:diagnostics_channel';
import { observeDiscoverTransport, type DiscoverTransportTiming } from '@/lib/discoverTransportTiming';
const publish = (name:string,request:object) => channel(name).publish({request});
afterEach(()=>jest.restoreAllMocks());

test('separates request preparation, dispatch, response wait and resumption without reading private data',async()=>{
  let now=0;
  jest.spyOn(performance,'now').mockImplementation(()=>now);
  const request=Object.defineProperties({},Object.fromEntries(['headers','origin','path','body'].map(key=>[
    key,{get(){throw Error('Private request data must not be inspected');}},
  ])));
  let observed:DiscoverTransportTiming|undefined;
  const value={response:'unchanged'};
  expect(await observeDiscoverTransport(async()=>{
    now=2;publish('undici:request:create',request);
    now=5;channel('undici:client:sendHeaders').publish({request,get headers(){throw Error('Do not read headers');}});
    now=105;channel('undici:request:headers').publish({request,get response(){throw Error('Do not read response headers');}});
    now=109;return value;
  },result=>{observed=result;})).toBe(value);
  expect(observed).toEqual({requests:1,sends:1,responses:1,phases:{prepare:2,dispatch:3,response:100,resume:4}});
});

test('overlapping logical fetches correlate by their own request object',async()=>{
  const requests=[{},{}];
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const records:DiscoverTransportTiming[]=[];
  await Promise.all(requests.map((request,index)=>observeDiscoverTransport(async()=>{
    publish('undici:request:create',request);
    if(index===0)await gate;else release();
    publish('undici:client:sendHeaders',request);
    publish('undici:request:headers',request);
  },value=>{records.push(value);} )));
  expect(records).toHaveLength(2);
  for(const record of records)expect(record).toMatchObject({requests:1,sends:1,responses:1,phases:expect.any(Object)});
});

test('unavailable hooks and malformed events remain unavailable rather than zero-duration phases',async()=>{
  const records:DiscoverTransportTiming[]=[];
  await observeDiscoverTransport(async()=>{
    channel('undici:request:create').publish(null);
    channel('undici:request:create').publish({request:1});
    channel('undici:request:create').publish({get request(){throw Error('Malformed observation');}});
    publish('undici:request:headers',{});
  },value=>{records.push(value);});
  expect(records).toEqual([{requests:0,sends:0,responses:0}]);
});

test('multiple physical requests cannot be mislabeled as one transport waterfall',async()=>{
  let observed:DiscoverTransportTiming|undefined;
  await observeDiscoverTransport(async()=>{
    for(const request of [{},{}])for(const name of ['undici:request:create','undici:client:sendHeaders','undici:request:headers'])publish(name,request);
  },result=>{observed=result;});
  expect(observed).toEqual({requests:2,sends:2,responses:2});
});

test('failed transport and a failed recorder preserve the original rejection',async()=>{
  const failure=new Error('Synthetic transport failure');
  await expect(observeDiscoverTransport(async()=>{
    publish('undici:request:create',{});throw failure;
  },()=>{throw Error('Recorder failed');})).rejects.toBe(failure);
});

test('late events cannot change a settled measurement or enter the next fetch',async()=>{
  const oldRequest={};
  const records:DiscoverTransportTiming[]=[];
  await observeDiscoverTransport(async()=>{publish('undici:request:create',oldRequest);},value=>{records.push(value);});
  await observeDiscoverTransport(async()=>{
    publish('undici:client:sendHeaders',oldRequest);publish('undici:request:headers',oldRequest);
  },value=>{records.push(value);});
  expect(records).toEqual([{requests:1,sends:0,responses:0},{requests:0,sends:0,responses:0}]);
});
