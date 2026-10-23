# Disaster recovery preparation

This is a recovery procedure and acceptance checklist, not a successful restore receipt.
Keep CreatorNet private and preserve current payment identities, buyers' owned access,
active service jobs, other checkouts and historical recovery evidence.

## Existing evidence and tools

October 22 security receipts recorded seven daily physical database backups, October
16–22, latest `2026-10-22T07:15:11Z`. No Production restoration, object restoration or
complete application recovery was exercised. Recheck current backup availability before
a recovery window; seven visible backups do not establish a contractual RPO or measured RTO.

September's separately approved staging restore used backup `2026-09-07T10:23:35Z` from
`nwqfofezfzljhxolkycz` into `cbqwdqfhpltkulpcqtlg`. Nine schema fingerprint groups,
13 table counts, 12 relationships and 15 financial ACL checks passed. That historical
project is preserved evidence, not an empty target. Do not restore over it or shared
Staging. See `docs/installment-staging-installation-plan.md` for the historical scope.

Existing Windows tools are under `C:/Users/sandy/CreatorNet-Recovery/tools/`:
`postgresql-17.11-3-windows-x64-binaries/pgsql/bin/` and
`age-v1.3.2-windows-amd64/age/`. PostgreSQL includes `pg_dump`, `pg_restore`, `psql`,
`initdb`, `postgres` and `pg_ctl`. September's offline verification and synthetic age
round trip are under the sibling `proofs/` folder. They are not real backup-key custody
or off-device decryption proof. Preserve the existing `vault/`; do not read keys for
context, write backup rows into Git/chat, reset passwords or reinstall tools by default.

## Select the isolated recovery method first

Physical Restore to a New Project copies database roles, Auth data and encryption root
key, but also copies enabled external-operation extensions. Cron, network hooks and
wrappers can run immediately after restoration; the provider does not offer an exclusion
step. Never call such a clone inert merely because no application deployment is attached.

Before selecting a method, capture a bounded read-only inventory of source identity,
server version, backup timestamp, ordinary/foreign relations, extensions, jobs, hooks,
wrappers, roles, RLS and integration metadata. Exclude credential values. Identify
outbound operations and decryption requirements. If they cannot be safely fenced before
execution, choose a logical restoration with inspection before activation.

A new local data directory using existing PostgreSQL binaries can support an offline
component drill, with loopback-only access and an effective outbound fence. It must have
a new explicit path and port and must not touch another server or data directory.
Unavailable managed extensions, Supabase Auth/Storage services and Vault root keys limit
parity. Record those gaps; a successful local SQL restoration is not hosted recovery.
No empty approved hosted target is established by this document. New hosted resources,
credential access, cost and target initialization require their reviewed execution scope.

## Backup and restore contract

1. Name the source, snapshot, approved isolated target, encrypted destination, retention
   owner, recovery-key holder, time budget and operation limits. Verify destination
   capacity and tool/server compatibility. Use an existing approved secure connection;
   never put passwords or keys in commands, transcripts or manifests.
2. Export a consistent logical snapshot under the approved scope, including required
   Auth records, roles, schemas, data, grants and migration history. Review managed-schema
   exclusions in the current provider guide; a public-schema-only export is incomplete.
   Encrypt customer data at the controlled destination and retain checksums, coverage,
   timestamps and aggregate comparison receipts without publishing rows.
3. Back up object bytes separately. Database backups include Storage metadata, not
   Storage files. Inventory actual Supabase buckets, R2 `creatornet-media` and
   `creatornet-video-processing-state`, plus private Stream asset dependencies. Use
   existing SDKs or approved tools, bounded listing/download, unique snapshot directories,
   streamed content checksums and preserved object metadata. A multipart ETag alone is
   not an independent full-content checksum. Never run a deleting mirror against a
   live bucket. Cloudflare Stream recovery requires its own verified coverage.
4. Restore only into the isolated target. Inspect schema/hooks/jobs before they can
   perform external operations. Keep application billing, email, webhooks and workers
   disconnected. Logical restoration does not automatically restore Vault root-key
   usability; preserve that as a separate secure provider/key-custody gate.
5. Compare schema fingerprints, selected counts, financial IDs/relationships, RLS/ACLs,
   migration history and encrypted-field usability without exposing secrets. Restore
   object bytes into an isolated local directory or approved private target and verify
   manifest hashes, metadata and database-to-object binding. Do not mutate original keys.
6. Record elapsed recovery time, chosen snapshot age, omissions, failures and exact
   identities. Full acceptance requires the intended managed services and application
   flows, not only catalog parity. Retain the encrypted backup and independent receipts.
   Cleanup of any target is a separately scoped operation after retention review.

Database restoration cannot undo a Stripe operation. Never replay payments, refunds,
transfers, webhook deliveries or migrations merely because a restored database is older.
Reconcile provider truth against preserved original identities before enabling issuance.

References: [database backup scope](https://supabase.com/docs/guides/platform/backups),
[physical clone behavior](https://supabase.com/docs/guides/platform/clone-project),
[logical backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
