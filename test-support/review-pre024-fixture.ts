import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { installStagingStructuralBaseline } from "./staging-catalog-postgres";
import ratingCatalog from "./staging-rating-catalog-20260908.json";

const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const reviewFixture = Object.freeze({ buyer: id(1), otherBuyer: id(2), creator: id(3), otherCreator: id(4),
  post: id(11), sameCreatorPost: id(12), otherPost: id(13), legacy: id(101), otherLegacy: id(102) });

/** Local fixture, not a dump or assertion about uninspected hosted routine bodies.
 * Financial/content structure comes from the captured September 6 catalog.
 * Reviews reproduce the September 8 pre-024 observation: seven columns, old
 * uniqueness, RLS, four original policies and broad effective client grants.
 * Defaults/auth.uid and purchase SELECT policy remain synthetic substitutes.
 * The timestamp trigger and rating recompute bodies are the later captured,
 * MD5-verified definitions, not copies reconstructed from their descriptions.
 */
export async function installPre024ReviewFixture(db: PGlite) {
  const f = reviewFixture;
  await installStagingStructuralBaseline(db);
  await db.exec(`
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant all on public.posts,public.purchases,public.profiles,public.admin_actions to service_role;
    grant all on public.purchases to anon,authenticated;
    -- Representative buyer SELECT policy; real purchase-policy review is separate.
    create policy fixture_buyer_read on public.purchases for select using(buyer_id=auth.uid());
    create table public.reviews(
      id uuid primary key default gen_random_uuid(), reviewer_id uuid not null references auth.users(id) on delete cascade,
      creator_id uuid not null references public.profiles(id) on delete cascade,
      rating integer not null check(rating between 1 and 5),
      comment text not null check(char_length(comment) between 10 and 1000),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      constraint reviews_reviewer_id_creator_id_key unique(reviewer_id,creator_id));
    alter table public.reviews enable row level security;
    create policy "Anyone can read reviews" on public.reviews for select using(true);
    create policy "Users can insert their own reviews" on public.reviews for insert with check(auth.uid()=reviewer_id);
    create policy "Users can update their own reviews" on public.reviews for update using(auth.uid()=reviewer_id)
      with check(auth.uid()=reviewer_id);
    create policy "Users can delete their own reviews" on public.reviews for delete using(auth.uid()=reviewer_id);
    grant all on public.reviews to anon,authenticated,service_role;
    -- Adversarial independent grants, not an assertion about grant provenance.
    grant update(id),insert(created_at),references(creator_id) on public.reviews to public,anon,authenticated;
  `);
  if (ratingCatalog.source_project !== "nwqfofezfzljhxolkycz" || ratingCatalog.transaction_read_only !== "on") {
    throw new Error("Unexpected review routine evidence");
  }
  for (const signature of ["public.update_reviews_updated_at()", "public.update_profile_rating(uuid)"]) {
    const routine = ratingCatalog.routines.find(row => row.signature === signature);
    if (!routine || createHash("md5").update(routine.definition, "utf8").digest("hex") !== routine.definition_fingerprint) {
      throw new Error("Review routine fingerprint drift");
    }
    await db.exec(routine.definition);
  }
  await db.exec(`create trigger update_reviews_updated_at before update on public.reviews
    for each row execute function public.update_reviews_updated_at()`);
  for (const user of [f.buyer, f.otherBuyer, f.creator, f.otherCreator]) {
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.profiles(id) values($1)", [user]);
  }
  for (const [index, post, creator] of [[21, f.post, f.creator], [22, f.sameCreatorPost, f.creator], [23, f.otherPost, f.otherCreator]] as const) {
    await db.query(`insert into public.products(id,creator_id,type,title,price_cents,amount_cents,currency)
      values($1,$2,'mentorship','Synthetic review prerequisite',10000,10000,'usd')`, [id(index), creator]);
    await db.query("insert into public.posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [post, id(index), creator]);
    await db.query(`insert into public.purchases(buyer_id,post_id,product_id,creator_id,currency,status,access_granted)
      values($1,$2,$3,$4,'usd',$5,true)`, [f.buyer, post, id(index), creator, index === 21 ? "active" : index === 22 ? "complete" : "paid"]);
  }
  await db.query(`insert into public.reviews(id,reviewer_id,creator_id,rating,comment,created_at,updated_at) values
    ($1,$2,$3,4,'Synthetic legacy buyer review','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),
    ($4,$5,$6,2,'Synthetic legacy other review','2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')`,
    [f.legacy, f.buyer, f.creator, f.otherLegacy, f.otherBuyer, f.otherCreator]);
}

/** Model the separately approved ACL prerequisite for these review-only tests.
 * This is not the hosted repair artifact and does not certify that artifact.
 */
export async function closeFixturePurchaseWrites(db: PGlite) {
  await db.exec("revoke all on public.purchases from public,anon,authenticated; grant select on public.purchases to anon,authenticated");
}
