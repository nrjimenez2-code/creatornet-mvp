# Search quality and video ingestion

## Relevance checks

Run `npx jest __tests__/search-query.test.ts __tests__/search-relevance-schema.test.ts __tests__/search-api.test.ts __tests__/search-client.test.ts __tests__/search-video-text.test.ts --runInBand` before release. Database fixtures must prove Luis is returned for ecom/e-commerce/ecommerce, learning interests alone do not establish expertise, unrelated queries return nothing, removed content disappears, exact identities rank first, and pages do not repeat creators.

Maintain a reviewed query set drawn from real searches, with expected creator/post/offering IDs and relevance grades (0 unrelated, 1 related, 2 directly useful). Include identity, broad topic, specific service, synonym, typo, hashtag, and no-match examples. Review the first ten results with the product owner; track precision@10, recall of known relevant creators, and reciprocal rank of the first directly useful result. Keep new creators in the set so popularity cannot hide a discovery regression. Do not infer success from nonempty results alone.

Before production cutover, verify real Luis content and e-commerce results, direct result links, both search entry points, all four tabs, clear/back behavior, and narrow/mobile layout. Hosted ingestion must produce actual extracted text, then a query present only in that text must retrieve its source video and creator.

## Analytics

Search uses the existing consent-aware PostHog client. Events are observational and never block results:

| Event | Interpretation |
| --- | --- |
| `search_performed` | Successful response, query, total result count, page, latency_ms, search_version |
| `search_no_results` | Successful first page with no results in any category |
| `search_reformulated` | A different query completed in the same mounted search session |
| `search_results_viewed` | Results rendered for a query and selected tab, with returned IDs |
| `search_result_opened` | Creator/video/offering opened, with its position and selected tab |

Use first-page `search_performed` events for the search denominator. Compare empty-result rate, sessions with a result open, first-open position, and p50/p95 latency by device and search version. Inspect frequent empty queries and searches followed by repeated reformulation. These events include debounced typing; reformulation is a diagnostic signal, not a standalone dissatisfaction metric. Render events describe displayed result lists, not proof that each card entered the viewport. Honor existing analytics consent and exclude QA sessions from product decisions.

## Video queue

Only visible, eligible creators' public `video_url` assets are processed. Configured public R2 and public Supabase storage origins are allowed; signed URLs and premium assets are excluded. `R2_PUBLIC_URL` must match the environment's actual media origin. Vercel AI Gateway uses the project's deployment identity. Confirm provider access and available credits before enabling ingestion in production.

The authenticated `/api/search/enrich` cron runs every ten minutes. Configure a production `CRON_SECRET` of at least 32 characters before release. Searches also wake one background job after responding. Database leases permit one extraction at a time, expire after four minutes, and reject stale writes. Retry failures up to three attempts with a thirty-minute delay. Source URL changes invalidate the old transcript immediately.

Current extraction limits are 500 MiB and ten minutes when duration is known. Unsupported media remains discoverable through its other public text. Inspect failures and coverage rather than treating an unprocessed video as understood:

```sql
select status, error_code, count(*)
from public.search_video_text_v1
group by status, error_code;

select count(*) as eligible_videos,
       count(v.post_id) filter (where v.status='ready' and v.source_url=p.video_url) as indexed_videos
from public.posts p join public.profiles c on c.id=p.creator_id
left join public.search_video_text_v1 v on v.post_id=p.id
where p.hidden_at is null and p.removed_at is null and c.banned_at is null
  and nullif(c.username,'') is not null and nullif(p.video_url,'') is not null;
```

After fixing a failure's cause, an operator may reset attempts/retry_at on the affected failed rows. Never reset an active lease. Track queue coverage, oldest waiting video, failure codes, and gateway spending. Increase ingestion capacity only after measuring volume and cost.

## Release and recovery

Follow `.github/workflows/schema-change-check.yml`: keep `DB MIGRATION REQUIRED` in the PR and apply 058 then 059 immediately after merge. The migrations are additive; production must have both RPCs before application cutover. Staging rehearsal and hosted verification precede merging. Deploy through the repository's GitHub integration, verify the exact merge SHA, then repeat the acceptance queries. If the application must roll back, preserve the additive tables and return to the previous known-good deployment; do not drop source data.
