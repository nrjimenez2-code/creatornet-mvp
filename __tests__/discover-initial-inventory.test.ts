import { readInitialDiscoverInventory } from '@/lib/discoverInitialInventory';
import { createMockClient, type MockClient, type Op } from './__mocks__/supabaseQueryMock';
let db: MockClient;
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return db; } }));
jest.mock('@/lib/supabaseServer', () => ({ createServerClient: jest.fn() }));
import { discoverInventory } from '@/lib/discoverServer';
const id = (n: number) => '00000000-0000-0000-0000-'+n.toString(16).padStart(12,'0');
const empty = () => ({ posts: [] as any[], profiles: [] as any[], primaryProducts: [] as any[], legacyProducts: [] as any[], offerings: [] as any[] });
const originalFlag = process.env.DISCOVER_INITIAL_INVENTORY_PAGE_ENABLED;
afterEach(() => { if (originalFlag === undefined) delete process.env.DISCOVER_INITIAL_INVENTORY_PAGE_ENABLED; else process.env.DISCOVER_INITIAL_INVENTORY_PAGE_ENABLED = originalFlag; });

test('reads beyond the REST row cap using an advancing cursor and reuses metadata across pages', async () => {
  const posts = Array.from({length:1001},(_,i)=>({id:id(i)}));
  const rpc = jest.fn(async (_name, args) => ({error:null,data:{...empty(),
    posts: args.p_after === null ? posts.slice(0,1000) : posts.slice(1000), profiles:[{id:id(9000),username:'creator'}]}}));
  const result = await readInitialDiscoverInventory({rpc} as any);
  expect(result.posts).toEqual(posts);expect(result.profiles).toHaveLength(1);
  expect(rpc.mock.calls).toEqual([
    ['discover_initial_inventory_page_v1',{p_after:null,p_limit:1000}],
    ['discover_initial_inventory_page_v1',{p_after:id(999),p_limit:1000}],
  ]);
});

test('a full final page makes one empty continuation request and terminates', async () => {
  const rpc=jest.fn().mockResolvedValueOnce({data:{...empty(),posts:Array.from({length:1000},(_,i)=>({id:id(i)}))},error:null})
    .mockResolvedValueOnce({data:empty(),error:null});
  expect((await readInitialDiscoverInventory({rpc} as any)).posts).toHaveLength(1000);expect(rpc).toHaveBeenCalledTimes(2);
});

test.each([
  {data:null,error:{code:'42501'}},
  {data:{...empty(),posts:[{id:id(2)},{id:id(1)}]},error:null},
  {data:{...empty(),posts:[{id:id(1)},{id:id(1)}]},error:null},
  {data:{...empty(),posts:Array.from({length:1001},(_,i)=>({id:id(i)}))},error:null},
  {data:{...empty(),profiles:[{id:'invalid'}]},error:null},
  {data:{...empty(),offerings:null},error:null},
])('fails closed on unavailable, oversized or invalid pages %#', async reply => {
  const rpc=jest.fn().mockResolvedValue(reply);await expect(readInitialDiscoverInventory({rpc} as any)).rejects.toBeDefined();expect(rpc).toHaveBeenCalledTimes(1);
});

test('a repeated continuation cursor fails instead of looping or returning a partial catalog', async () => {
  const page={...empty(),posts:Array.from({length:1000},(_,i)=>({id:id(i)}))};const rpc=jest.fn().mockResolvedValue({data:page,error:null});
  await expect(readInitialDiscoverInventory({rpc} as any)).rejects.toThrow('cursor');expect(rpc).toHaveBeenCalledTimes(2);
});

test('enabled initial batching preserves moderation, offer ownership, signed URLs and legacy product mapping', async () => {
  const creator=id(100),other=id(101),product=id(200),legacy=id(201),legacyAlias=id(202),offering=id(300);
  const rows={...empty(),posts:[
    {id:id(1),creator_id:creator,product_id:product,video_url:'https://media.example.test/private.mp4?signature=unchanged',active:true},
    {id:id(2),creator_id:creator,product_id:legacyAlias,poster_url:'https://media.example.test/poster.jpg'},
    {id:id(3),creator_id:creator,offering_id:offering,poster_url:'https://media.example.test/offer.jpg'},
    {id:id(4),creator_id:creator,product_id:id(203),poster_url:'https://media.example.test/foreign.jpg'},
    {id:id(5),creator_id:creator,hidden_at:'2026-01-01',poster_url:'https://media.example.test/hidden.jpg'},
    {id:id(6),creator_id:other,poster_url:'https://media.example.test/banned.jpg'},
    {id:id(7),creator_id:creator,active:false,poster_url:'https://media.example.test/inactive.jpg'},
    {id:id(8),creator_id:creator,removed_at:'2026-01-01',poster_url:'https://media.example.test/removed.jpg'},
  ],profiles:[{id:creator,username:'creator'},{id:other,banned_at:'2026-01-01'}],
    primaryProducts:[{id:product,creator_id:creator,type:'course',active:true,title:'Course'},{id:id(203),creator_id:other,type:'course',active:true}],
    legacyProducts:[{id:legacy,product_id:legacyAlias,creator_id:creator,type:'video',active:true,title:'Legacy'}],
    offerings:[{id:offering,creator_id:creator,type:'call',is_active:true,title:'Call',product_metadata:{description:'description'}}]};
  const respond=(op:Op)=>({error:null,data:op.table==='discover_initial_inventory_page_v1'?rows:
    op.table==='posts'?rows.posts:op.table==='profiles'?rows.profiles:op.table==='offerings'?rows.offerings:
    op.table==='products'?(op.inFilters[0].column==='product_id'?rows.legacyProducts:rows.primaryProducts):[]});
  db=createMockClient(respond);delete process.env.DISCOVER_INITIAL_INVENTORY_PAGE_ENABLED;
  const legacyResult=await discoverInventory();
  db=createMockClient(respond);process.env.DISCOVER_INITIAL_INVENTORY_PAGE_ENABLED='true';
  const batched=await discoverInventory();expect(batched).toEqual(legacyResult);expect(batched.map(p=>p.id)).toEqual([id(1),id(2),id(3),id(4)]);
  expect(db.ops).toHaveLength(1);expect(db.ops[0].table).toBe('discover_initial_inventory_page_v1');
  expect(batched[3].product).toBeUndefined();expect(batched[1].product.id).toBe(legacy);
  expect(batched[0].video_url).toContain('signature=unchanged');
  db=createMockClient(respond);expect(await discoverInventory(undefined,rows)).toEqual(legacyResult);expect(db.ops).toHaveLength(0);
  db=createMockClient(respond);await discoverInventory([id(1)]);expect(db.ops.some(op=>op.table==='discover_initial_inventory_page_v1')).toBe(false);
});
