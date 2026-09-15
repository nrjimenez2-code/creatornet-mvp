import {
  createMockClient,
  type MockClient,
} from "./__mocks__/supabaseQueryMock";
let db: MockClient;
jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({}) }));
import { recordDiscoverEvent, recordDiscoverEvents } from "@/lib/discoverServer";

test.each([true, false])(
  "event topics use captions and active legacy offers (active=%s)",
  async (active) => {
    db = createMockClient((op) => {
      if (op.table === "posts")
        return {
          data: {
            id: "post",
            creator_id: "creator",
            interests: [],
            topics: [],
            title: "My workshop",
            caption: "Portrait photography",
            product_id: "legacy-product",
          },
          error: null,
        };
      if (op.table === "products")
        return {
          data:
            op.inFilters[0]?.column === "product_id"
              ? [
                  {
                    id: "product",
                    product_id: "legacy-product",
                    creator_id: "creator",
                    title: "E-commerce mentorship",
                    description: "Shopify store coaching",
                    type: "mentorship",
                    active,
                  },
                ]
              : [],
          error: null,
        };
      return { data: null, error: null };
    });
    const originalFrom = db.from;
    db.from = (table) => {
      const source = originalFrom(table);
      return { ...source, upsert: source.insert };
    };
    await recordDiscoverEvent({
      actor: "user:viewer",
      userId: "viewer",
      postId: "post",
      kind: "qualified_view",
      entityKey: "session:post",
      audience: "general",
    });
    const event = db.opsFor("discover_events_v1")[0].payload as {
      topics: string[];
      offer_type: string;
    };
    expect(event.topics).toContain("photography");
    if (active) {
      expect(event.topics).toContain("ecommerce mentorship");
      expect(event.offer_type).toBe("mentorship");
    } else {
      expect(event.topics).not.toContain("ecommerce mentorship");
      expect(event.offer_type).toBe("none");
    }
  },
);

test('one watch batch shares metadata and one deduplicated write across its events',async()=>{
 db=createMockClient(op=>op.table==='posts'
  ? {data:{id:'post',creator_id:'creator',caption:'Portrait photography'},error:null}
  : {data:null,error:null});
 const original=db.from;
 db.from=table=>{const source=original(table);return {...source,upsert:source.insert};};
 await recordDiscoverEvents({actor:'user:viewer',userId:'viewer',postId:'post',audience:'photography'},
  ['exposure','qualified_view','completion'].map(kind=>({kind,entityKey:'session:post'})));
 expect(db.opsFor('posts')).toHaveLength(1);
 expect(db.opsFor('discover_events_v1')).toHaveLength(1);
 const rows=db.opsFor('discover_events_v1')[0].payload as Array<{kind:string;topics:string[];entity_key:string}>;
 expect(rows.map(r=>r.kind)).toEqual(['exposure','qualified_view','completion']);
 for(const row of rows){expect(row.topics).toContain('photography');expect(row.entity_key).toBe('session:post');}
});

test('request metadata retains topic credit without rereading the post',async()=>{
 db=createMockClient(op=>{
  if(op.table==='posts')throw new Error('Unexpected post reread');
  return {data:null,error:null};
 });
 const original=db.from;
 db.from=table=>{const source=original(table);return {...source,upsert:source.insert};};
 await recordDiscoverEvents({actor:'user:viewer',userId:'viewer',postId:'post',audience:'photography'},
  [{kind:'qualified_view',entityKey:'session:post'}],
  {id:'post',creator_id:'creator',caption:'Portrait photography',allow_booking:true});
 expect(db.opsFor('posts')).toHaveLength(0);
 expect(db.opsFor('discover_events_v1')[0].payload).toEqual(expect.objectContaining({
  post_id:'post',creator_id:'creator',topics:expect.arrayContaining(['photography']),offer_type:'free_call',
 }));
});

test('request metadata cannot cross posts or grant self-credit',async()=>{
 db=createMockClient(()=>{throw new Error('No database operation expected');});
 const input={actor:'user:viewer',userId:'viewer',postId:'post',audience:'general'};
 const events=[{kind:'qualified_view',entityKey:'session:post'}];
 await expect(recordDiscoverEvents(input,events,{id:'another-post',creator_id:'creator'})).rejects.toThrow('metadata post mismatch');
 await expect(recordDiscoverEvents(input,events,{id:'post',creator_id:'viewer'})).resolves.toBeUndefined();
});
