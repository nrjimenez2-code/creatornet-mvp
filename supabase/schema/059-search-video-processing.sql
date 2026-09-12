-- Server-only leases make video enrichment resumable without tying it to uploads.
begin;
create or replace function public.claim_search_video_v1()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare target public.posts; token uuid := gen_random_uuid();
begin
  if not pg_try_advisory_xact_lock(58920260912) then return null; end if;
  -- At most one active extraction at a time. Public requests cannot fan out calls.
  if exists(select 1 from public.search_video_text_v1 where status='processing' and lease_until>now()) then return null; end if;
  select p.* into target from public.posts p
  join public.profiles c on c.id=p.creator_id
  left join public.search_video_text_v1 v on v.post_id=p.id
  where p.hidden_at is null and p.removed_at is null and c.banned_at is null
    and nullif(trim(c.username),'') is not null and nullif(p.video_url,'') is not null
    and (v.post_id is null or v.source_url<>p.video_url or
      (v.status<>'ready' and v.attempts<3 and v.retry_at<=now() and (v.lease_until is null or v.lease_until<now())))
  order by (v.post_id is null) desc,p.created_at desc,p.id limit 1;
  if target.id is null then return null; end if;
  insert into public.search_video_text_v1(post_id,source_url,status,attempts,lease_token,lease_until,updated_at)
    values(target.id,target.video_url,'processing',1,token,now()+interval '4 minutes',now())
  on conflict(post_id) do update set
    source_url=excluded.source_url,status='processing',
    attempts=case when search_video_text_v1.source_url=excluded.source_url then search_video_text_v1.attempts+1 else 1 end,
    transcript='',screen_text='',lease_token=token,lease_until=excluded.lease_until,updated_at=now();
  return jsonb_build_object('post_id',target.id,'source_url',target.video_url,'lease_token',token,'duration_seconds',target.duration_seconds);
end;
$$;
revoke all on function public.claim_search_video_v1() from public,anon,authenticated;
grant execute on function public.claim_search_video_v1() to service_role;

create or replace function public.finish_search_video_v1(target_post uuid,token uuid,spoken_text text,visible_text text,model_id text,failure_code text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  update public.search_video_text_v1 v set
    status=case when failure_code is null then 'ready' else 'failed' end,
    transcript=case when failure_code is null then left(coalesce(spoken_text,''),60000) else '' end,
    screen_text=case when failure_code is null then left(coalesce(visible_text,''),20000) else '' end,
    model=model_id,error_code=left(failure_code,80),lease_until=null,lease_token=null,retry_at=now()+interval '30 minutes',updated_at=now()
  where v.post_id=target_post and v.lease_token=token and v.status='processing'
    and exists(select 1 from public.posts p join public.profiles c on c.id=p.creator_id where p.id=v.post_id
      and p.video_url=v.source_url and p.hidden_at is null and p.removed_at is null and c.banned_at is null);
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;
revoke all on function public.finish_search_video_v1(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_search_video_v1(uuid,uuid,text,text,text,text) to service_role;
commit;
