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
import { recordDiscoverEvent } from "@/lib/discoverServer";

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
