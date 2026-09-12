-- READ-ONLY REVIEW ARTIFACT. Confirm the dashboard is CreatorNet Staging
-- (nwqfofezfzljhxolkycz) separately; database metadata cannot prove project ID.
-- One JSON result, no application RPCs, customer rows, raw routine bodies or
-- raw routine configurations. Hashes are drift indicators, not a safety verdict.
-- Embedded collision identities are copied from the canonical local manifest:
-- test-support/exact-staging-bundle-manifest.json (040-057; 18 source files).
-- Revalidate that snapshot if the manifest changes. Absence of collisions does
-- not establish schema compatibility or authorize any migration/deployment.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

with manifest as (
  select $manifest${"schemaVersion":1,"projectRefForOperatorCheckOnly":"nwqfofezfzljhxolkycz","hashEncoding":"SHA-256 of UTF-8 source after CRLF-to-LF normalization only","sources":[["040-exact-installment-agreements.sql","b0b8a3eee31cb7cd36ec58fcdeda75563684ac7fbe3c14de654996e520bb2300"],["041-exact-installment-receipt-credit.sql","c41d83f882290627e8fc01c25dbf2f772a89ae0db38a4b2224d49b391dde9654"],["042-exact-installment-activation.sql","28ae2965e54dc3f9dc20804dcf9b9a4705f6324220876643694b9fc2bf884a24"],["043-exact-installment-invoice-claims.sql","a435e75e05dde61bdf8ec32c45cf37d108488cae0e628e49d76473ef1b176638"],["044-exact-installment-purchase-lifecycle.sql","69842e90a2a7a246fcb5e1357ccda433897176659f6c2791ee1194a799193de6"],["045-exact-installment-collection-holds.sql","ff42991a31f9615f6c2fe49bc69cc5e478765aff51b21de10d6594632a713352"],["046-exact-installment-refund-events.sql","41674833811f3498b13643ec05517d3c287bf04de20137050bd2ad73bada7875"],["047-exact-installment-billing-stops.sql","39133e399b015c6b7ae025a2186b6b6bae0f86257917959448112d97c63ca129"],["048-exact-installment-lifecycle-events.sql","1976615a31c6e392cd31d8a419dec5d9947ead96a93b84c122e40a0e430244f7"],["049-exact-installment-payment-recovery.sql","1aba8fe6f4b57c639a5ca55d1ce6f0421d7b96f9ebb9a4249896106dc6c694c5"],["050-exact-installment-stop-request-identity.sql","d376b4351af6838850b68fcb3c353224794101ec19a652c6ec2184bc2c87d0c2"],["051-exact-installment-card-setup.sql","deca548eaa28f0e99b03027a05c37bbdb2b20e84e821c8caf25081372be2655c"],["052-exact-installment-payment-confirmation.sql","b97eb428a03a572abf1f96f0cb78f89f5efdd5b35ff36f7e7e3dfa714cb9ac73"],["053-exact-installment-retry-admission.sql","35def239f92d7ce7ca82e9083e8c118d1ebb42e5cd614d8e2410633149957fc5"],["054-exact-installment-payment-intent-version.sql","48a9205a9206697929e0ac0fc0c86792ae80cdadb1c7ba96dc20c4122e60d983"],["055-exact-installment-bank-verification.sql","3c223ab0ada5c2c269512820eae120de4ce099c2bfff22500aaf99ad773951d5"],["056-exact-installment-future-card-consent.sql","3a63aea00fb2935f86c63dd016a38948e28e09c3606efe178e3ed2bb2bb62154"],["057-exact-installment-checkout-publication.sql","86bafab16b8346b83920c38485b28e2290c0ef2cd6db9df93a6e18715f3fd67f"]],"relations":[["exact_installment_activations","r"],["exact_installment_activations_pkey","i"],["exact_installment_agreements","r"],["exact_installment_agreements_booking_payment_id_key","i"],["exact_installment_agreements_pkey","i"],["exact_installment_agreements_purchase_id_key","i"],["exact_installment_agreements_stripe_checkout_session_id_key","i"],["exact_installment_agreements_stripe_customer_id_key","i"],["exact_installment_agreements_stripe_subscription_id_key","i"],["exact_installment_billing_stops","r"],["exact_installment_billing_stops_pkey","i"],["exact_installment_billing_stops_request_id_key","i"],["exact_installment_card_setups","r"],["exact_installment_card_setups_pkey","i"],["exact_installment_card_setups_stripe_checkout_session_id_key","i"],["exact_installment_card_setups_stripe_invoice_id_key","i"],["exact_installment_card_setups_stripe_setup_intent_id_key","i"],["exact_installment_collection_holds","r"],["exact_installment_collection_holds_agreement","i"],["exact_installment_collection_holds_pkey","i"],["exact_installment_collection_holds_refund_operation_id_key","i"],["exact_installment_collection_holds_request_id_key","i"],["exact_installment_collection_holds_stripe_event_id_key","i"],["exact_installment_future_card_choices","r"],["exact_installment_future_card_choices_pkey","i"],["exact_installment_invoice_cards","r"],["exact_installment_invoice_cards_pkey","i"],["exact_installment_invoice_claims","r"],["exact_installment_invoice_claims_pkey","i"],["exact_installment_invoice_claims_stripe_invoice_id_key","i"],["exact_installment_invoice_claims_stripe_payment_intent_id_key","i"],["exact_installment_invoice_recovery_hold","i"],["exact_installment_lifecycle_observations","r"],["exact_installment_lifecycle_observations_pkey","i"],["exact_installment_one_booking","i"],["exact_installment_one_cancellation_request","i"],["exact_installment_one_confirmed_retry","i"],["exact_installment_operations","r"],["exact_installment_operations_pkey","i"],["exact_installment_payment_confirmations","r"],["exact_installment_payment_confirmations_pkey","i"],["exact_installment_payment_recoveri_stripe_payment_intent_id_key","i"],["exact_installment_payment_recoveries","r"],["exact_installment_payment_recoveries_pkey","i"],["exact_installment_periods","r"],["exact_installment_periods_agreement_id_due_at_key","i"],["exact_installment_periods_pkey","i"],["exact_installment_receipts","r"],["exact_installment_receipts_ledger_id_key","i"],["exact_installment_receipts_pkey","i"],["exact_installment_receipts_stripe_invoice_id_key","i"],["exact_installment_receipts_stripe_payment_intent_id_key","i"],["exact_installment_resolved_card_holds","r"],["exact_installment_resolved_card_holds_pkey","i"],["exact_installment_retry_admissions","r"],["exact_installment_retry_admissions_pkey","i"],["exact_installment_retry_admissions_stripe_invoice_id_key","i"]],"functions":[["admit_exact_installment_admin_refund(uuid,uuid)",true,true],["admit_exact_installment_admin_refund_before_recovery(uuid,uuid)",false,true],["admit_exact_installment_dispatch(uuid,text,uuid)",true,true],["admit_exact_installment_retry(uuid,uuid)",true,true],["admit_exact_installment_retry_original(uuid,uuid)",false,true],["apply_exact_installment_dispute_event(uuid,text,text,bigint,jsonb,text,text,bigint,bigint,text,bigint)",true,true],["apply_exact_installment_refund_event(uuid,text,text,text,bigint,bigint)",true,true],["assert_exact_card_setup_eligible(uuid,text,uuid)",false,true],["assert_exact_installment_activation_ready(uuid)",false,true],["assert_exact_installment_billing_stop(uuid,uuid,uuid,uuid)",true,true],["assert_exact_installment_renewal_ready(uuid,integer)",false,true],["begin_exact_installment_recovery(uuid,text)",true,true],["bind_exact_card_setup(uuid,uuid,text)",true,true],["bind_exact_installment_checkout(uuid,text,text,text)",true,true],["bind_exact_installment_purchase(uuid,uuid)",true,true],["claim_exact_installment_activation(uuid,text,text,uuid)",true,true],["claim_exact_installment_billing_stop(uuid,uuid,uuid,uuid)",true,true],["claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid)",true,true],["claim_exact_installment_invoice_original(uuid,text,text,bigint,bigint,uuid)",false,true],["claim_exact_installment_operation(uuid,text,text,uuid)",true,true],["complete_exact_installment_activation(uuid,uuid)",true,true],["complete_exact_installment_agreement(uuid)",true,true],["complete_exact_installment_billing_stop(uuid,uuid,uuid,uuid,text,text,bigint,text,text)",true,true],["complete_exact_installment_operation(uuid,text,uuid,text)",true,true],["confirm_exact_installment_future_card(uuid,uuid,boolean,text)",true,true],["confirm_exact_installment_retry(uuid,uuid,text)",true,true],["create_exact_installment_agreement(uuid,uuid,uuid,jsonb)",true,true],["credit_exact_installment_receipt(uuid,integer,text,text,bigint)",true,true],["exact_installment_lifecycle_basis(uuid)",false,true],["exact_installment_month(bigint,integer)",false,false],["exact_installment_recovery_basis(uuid,text)",false,true],["exact_installment_recovery_is_terminal(uuid,text,text)",false,true],["exact_installment_stop_is_quiescent(uuid)",false,true],["finish_exact_installment_lifecycle(uuid,text,text,bigint,jsonb,text,jsonb)",true,true],["finish_exact_installment_recovery(uuid,text,text,bigint,jsonb,text,text,jsonb)",true,true],["fulfill_exact_installment_first_payment(uuid)",true,true],["guard_exact_installment_activation_hold()",false,true],["guard_exact_installment_booking_binding()",false,true],["guard_exact_installment_checkout_estimate()",false,true],["hold_exact_installment_for_cancellation(uuid,uuid,uuid)",true,true],["hold_exact_installment_lifecycle_event(uuid,text,text,text)",true,true],["hold_exact_installment_refund_event(uuid,text,text,text,bigint)",true,true],["prepare_exact_installment_dispatch(uuid,text,text,uuid)",true,true],["publish_exact_installment_checkout(uuid,uuid,text,text,uuid,text,bigint,text)",true,true],["quote_exact_installment_future_card(uuid,uuid,uuid)",true,true],["quote_exact_installment_retry(uuid,uuid,uuid)",true,true],["quote_exact_installment_retry(uuid,uuid,uuid,text)",true,true],["read_current_exact_card_setup(uuid,uuid)",true,true],["read_exact_buyer_recovery(uuid,uuid)",true,true],["read_exact_buyer_recovery_original(uuid,uuid)",false,true],["read_exact_installment_bank_context(uuid,text,uuid,boolean)",true,true],["read_exact_installment_lifecycle(uuid,text)",true,true],["reconcile_exact_installment_dispute_audit(text)",true,true],["record_exact_installment_first_receipt(uuid,text,text,bigint,bigint,timestamp with time zone)",true,true],["record_exact_installment_renewal_receipt(uuid,text,text,bigint,bigint,timestamp with time zone)",true,true],["record_exact_installment_retry_receipt(uuid,text,text,bigint,bigint,timestamp with time zone)",true,true],["reserve_exact_card_setup(uuid,uuid,text,uuid,text)",true,true],["reserve_exact_installment_checkout(uuid,uuid,integer,text,jsonb,jsonb)",true,true],["seed_exact_installment_purchase(uuid)",true,true],["verify_exact_card_setup(uuid,uuid,text,text,text)",true,true]],"triggers":[["booking_payments","exact_installment_booking_binding","guard_exact_installment_booking_binding()",19],["booking_payments","exact_installment_checkout_estimate","guard_exact_installment_checkout_estimate()",19],["exact_installment_activations","exact_installment_activation_hold","guard_exact_installment_activation_hold()",7]],"legacyColumns":[["booking_payments","installment_collection_version"]],"legacyConstraints":[["booking_payments","booking_payments_installment_collection_version_check"]]}$manifest$::jsonb as doc
), required_roles(role_name) as (
  values ('anon'),('authenticated'),('service_role')
), inspected_roles as (
  select q.role_name,r.oid,r.rolsuper,r.rolbypassrls,r.rolinherit
  from required_roles q left join pg_roles r on r.rolname=q.role_name
), required_relations(name) as (
  values ('reviews'),('posts'),('products'),('purchases'),('profile_reviews')
), relation_rows as (
  select q.name as relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    pg_get_userbyid(c.relowner) as owner,
    case when ar.oid is not null then pg_has_role(ar.oid,c.relowner,'USAGE') end as anon_inherits_owner,
    case when ur.oid is not null then pg_has_role(ur.oid,c.relowner,'USAGE') end as authenticated_inherits_owner,
    c.oid is not null as present,
    case when c.oid is not null then md5(jsonb_build_object('name',q.name,'kind',c.relkind,
      'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner))::text)
      end as relation_metadata_fingerprint
  from required_relations q left join pg_class c on c.oid=to_regclass('public.'||q.name)
  left join inspected_roles ar on ar.role_name='anon'
  left join inspected_roles ur on ur.role_name='authenticated'
), column_rows as (
  select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type_name,
    a.attnotnull,d.oid is not null as has_default,
    md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) as default_fingerprint
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and a.attnum>0 and not a.attisdropped
    and (c.relname='reviews' or (c.relname in ('posts','products','purchases')
      and a.attname in ('id','creator_id','product_id','post_id','buyer_id','access_granted','status')))
), constraint_rows as (
  select c.conrelid::regclass::text as table_name,c.conname,c.contype,c.convalidated,
    pg_get_constraintdef(c.oid,true) as constraint_definition
  from pg_constraint c where c.conrelid in
    (to_regclass('public.reviews'),to_regclass('public.posts'),to_regclass('public.products'))
    and c.contype in ('p','u','f')
), index_rows as (
  select i.indexrelid::regclass::text as index_name,i.indisunique,i.indisvalid,i.indisready,
    pg_get_indexdef(i.indexrelid) as index_definition
  from pg_index i where i.indrelid=to_regclass('public.reviews')
), policy_rows as (
  select p.polname,p.polcmd,p.polpermissive,
    array(select r.rolname::text from pg_roles r where r.oid=any(p.polroles) order by r.rolname) as named_roles,
    0=any(p.polroles) as applies_to_public,p.polqual is null as no_using,
    pg_get_expr(p.polqual,p.polrelid)='(auth.uid() = reviewer_id)' as using_self_only,
    pg_get_expr(p.polwithcheck,p.polrelid)='(auth.uid() = reviewer_id)' as check_self_only,
    md5(coalesce(pg_get_expr(p.polqual,p.polrelid),'')) as using_fingerprint,
    md5(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) as check_fingerprint
  from pg_policy p where p.polrelid=to_regclass('public.reviews')
), table_grants as (
  select r.role_name,c.relname,
    array_agg(v.privilege_name order by v.privilege_name)
      filter(where has_table_privilege(r.oid,c.oid,v.privilege_name)) as effective_privileges,
    array_agg(v.privilege_name order by v.privilege_name)
      filter(where has_table_privilege(r.oid,c.oid,v.privilege_name||' WITH GRANT OPTION')) as grant_options
  from inspected_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege_name)
  where r.oid is not null and n.nspname='public' and c.relname in ('reviews','purchases')
  group by r.role_name,c.relname
), column_grants as (
  select r.role_name,c.relname,a.attname,
    coalesce(array_agg(v.privilege_name order by v.privilege_name)
      filter(where has_column_privilege(r.oid,c.oid,a.attnum,v.privilege_name)),array[]::text[]) as effective_privileges,
    coalesce(array_agg(v.privilege_name order by v.privilege_name)
      filter(where has_column_privilege(r.oid,c.oid,a.attnum,v.privilege_name||' WITH GRANT OPTION')),array[]::text[]) as grant_options
  from inspected_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege_name)
  where r.oid is not null and r.role_name in ('anon','authenticated')
    and n.nspname='public' and c.relname in ('reviews','purchases')
  group by r.role_name,c.relname,a.attname
), grouped_column_grants as (
  select role_name,relname,jsonb_agg(jsonb_build_object('column',attname,
    'effective_privileges',effective_privileges,'grant_options',grant_options) order by attname) as columns
  from column_grants group by role_name,relname
), trigger_rows as (
  select t.tgname,t.tgenabled,t.tgtype,p.oid::regprocedure::text as routine,
    pg_get_userbyid(p.proowner) as routine_owner,p.prosecdef,
    p.proconfig @> array['search_path=pg_catalog'] as pg_catalog_pinned,
    md5(coalesce(array_to_string(p.proconfig,'|'),'')) as configuration_fingerprint,
    md5(pg_get_functiondef(p.oid)) as routine_fingerprint
  from pg_trigger t join pg_proc p on p.oid=t.tgfoid
  where t.tgrelid=to_regclass('public.reviews') and not t.tgisinternal
), candidate_routines as (
  select p.oid::regprocedure::text as existing_candidate_routine,
    pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.prokind,
    p.proconfig @> array['search_path=pg_catalog'] as pg_catalog_pinned,
    md5(coalesce(array_to_string(p.proconfig,'|'),'')) as configuration_fingerprint,
    case when p.prokind<>'a' then md5(pg_get_functiondef(p.oid)) end as definition_fingerprint,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from inspected_roles r where r.role_name='anon') as anon_execute,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from inspected_roles r where r.role_name='authenticated') as authenticated_execute,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from inspected_roles r where r.role_name='service_role') as service_execute
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('has_live_purchase_of_post','can_review_purchased_post','keep_review_identity',
    'set_profile_rating','update_profile_rating')
), expected_exact_relations as (
  select x->>0 as name,x->>1 as expected_kind from manifest,jsonb_array_elements(doc->'relations') x
), exact_relation_collisions as (
  select e.name,e.expected_kind,c.relkind as existing_kind
  from expected_exact_relations e join pg_class c on c.oid=to_regclass('public.'||e.name)
), exact_prefix_relations as (
  select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname like 'exact\_installment\_%' escape '\'
), expected_exact_types as (
  select name as type_name from expected_exact_relations where expected_kind='r'
  union all select '_'||name from expected_exact_relations where expected_kind='r'
), exact_type_collisions as (
  select e.type_name,t.typtype,t.typrelid<>0 as has_associated_relation
  from expected_exact_types e join pg_type t on t.typname=e.type_name
  join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
), required_legacy_functions(signature) as (
  -- Exact identities from prepare-exact-staging-bundle.cjs preflightSql().
  values ('public.apply_payment_fee_ledger_refund(uuid,bigint)'),
    ('public.record_payment_refund_state(text,text,bigint,bigint)'),
    ('public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint)')
), legacy_function_presence as (
  select signature,to_regprocedure(signature) is not null as present
  from required_legacy_functions
), expected_exact_function_names as (
  select distinct split_part(x->>0,'(',1) as name from manifest,jsonb_array_elements(doc->'functions') x
), exact_function_collisions as (
  -- Any overload of a canonical function NAME is a collision, not only the
  -- precise signature the pending bundle would install.
  select e.name,p.oid::regprocedure::text as existing_signature,p.prokind,p.prosecdef,
    pg_get_userbyid(p.proowner) as owner
  from expected_exact_function_names e join pg_proc p on p.proname=e.name
  join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), exact_trigger_collisions as (
  select x->>0 as table_name,x->>1 as trigger_name,t.tgenabled,t.tgtype,
    t.tgfoid::regprocedure::text as existing_routine
  from manifest,jsonb_array_elements(doc->'triggers') x
  join pg_trigger t on t.tgrelid=to_regclass('public.'||(x->>0)) and t.tgname=x->>1
), exact_column_collisions as (
  select x->>0 as table_name,x->>1 as column_name,format_type(a.atttypid,a.atttypmod) as existing_type
  from manifest,jsonb_array_elements(doc->'legacyColumns') x
  join pg_attribute a on a.attrelid=to_regclass('public.'||(x->>0)) and a.attname=x->>1
    and a.attnum>0 and not a.attisdropped
), exact_constraint_collisions as (
  select x->>0 as table_name,x->>1 as constraint_name,c.contype,c.convalidated
  from manifest,jsonb_array_elements(doc->'legacyConstraints') x
  join pg_constraint c on c.conrelid=to_regclass('public.'||(x->>0)) and c.conname=x->>1
)
select jsonb_build_object(
  'observation',jsonb_build_object(
    'observed_at',clock_timestamp(),'inspected_role',current_user,
    'transaction_read_only',current_setting('transaction_read_only'),
    'server_version_num',current_setting('server_version_num'),
    'search_path',current_setting('search_path'),
    'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'),
    'inspected_role_superuser',(select rolsuper from pg_roles where rolname=current_user),
    'inspected_role_bypassrls',(select rolbypassrls from pg_roles where rolname=current_user)),
  'roles',coalesce((select jsonb_agg(jsonb_build_object('role_name',role_name,'present',oid is not null,
    'superuser',rolsuper,'bypassrls',rolbypassrls,'inherit',rolinherit) order by role_name) from inspected_roles),'[]'::jsonb),
  'relations',coalesce((select jsonb_agg(to_jsonb(r) order by relname) from relation_rows r),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(to_jsonb(r) order by relname,attname) from column_rows r),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(to_jsonb(r) order by table_name,conname) from constraint_rows r),'[]'::jsonb),
  'review_indexes',coalesce((select jsonb_agg(to_jsonb(r) order by index_name) from index_rows r),'[]'::jsonb),
  'review_policies',coalesce((select jsonb_agg(to_jsonb(r) order by polname) from policy_rows r),'[]'::jsonb),
  'table_privileges',coalesce((select jsonb_agg(jsonb_build_object('role_name',role_name,'table_name',relname,
    'effective_privileges',coalesce(effective_privileges,array[]::text[]),
    'grant_options',coalesce(grant_options,array[]::text[])) order by role_name,relname) from table_grants),'[]'::jsonb),
  'column_privileges',coalesce((select jsonb_agg(to_jsonb(r) order by role_name,relname) from grouped_column_grants r),'[]'::jsonb),
  'review_triggers',coalesce((select jsonb_agg(to_jsonb(r) order by tgname) from trigger_rows r),'[]'::jsonb),
  'existing_review_candidate_routines',coalesce((select jsonb_agg(to_jsonb(r) order by existing_candidate_routine) from candidate_routines r),'[]'::jsonb),
  'exact_bundle',jsonb_build_object(
    'manifest_path','test-support/exact-staging-bundle-manifest.json',
    'inventory_counts',(select jsonb_build_object('sources',jsonb_array_length(doc->'sources'),
      'relations',jsonb_array_length(doc->'relations'),'function_signatures',jsonb_array_length(doc->'functions'),
      'function_names',(select count(*) from expected_exact_function_names),'triggers',jsonb_array_length(doc->'triggers'),
      'legacy_columns',jsonb_array_length(doc->'legacyColumns'),'legacy_constraints',jsonb_array_length(doc->'legacyConstraints')) from manifest),
    'legacy_schema',jsonb_build_object('public_schema_present',to_regnamespace('public') is not null,
      'booking_payments_present',to_regclass('public.booking_payments') is not null),
    'required_legacy_functions',coalesce((select jsonb_agg(to_jsonb(r) order by signature) from legacy_function_presence r),'[]'::jsonb),
    'relation_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by name) from exact_relation_collisions r),'[]'::jsonb),
    'broad_prefix_relations',coalesce((select jsonb_agg(to_jsonb(r) order by relname) from exact_prefix_relations r),'[]'::jsonb),
    'row_array_type_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by type_name) from exact_type_collisions r),'[]'::jsonb),
    'function_name_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by name,existing_signature) from exact_function_collisions r),'[]'::jsonb),
    'trigger_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by table_name,trigger_name) from exact_trigger_collisions r),'[]'::jsonb),
    'legacy_column_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by table_name,column_name) from exact_column_collisions r),'[]'::jsonb),
    'legacy_constraint_collisions',coalesce((select jsonb_agg(to_jsonb(r) order by table_name,constraint_name) from exact_constraint_collisions r),'[]'::jsonb))
) as preflight;
rollback;
