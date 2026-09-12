/** The reviewed card-payment consumers read September/October Clover snapshots
 * and fetch current resources using the pinned October API. Retrieving an old
 * Event does not convert its data or api_version to the request's version.
 *
 * This checks representation compatibility only. Signature/account/mode,
 * ownership, resource identities and fresh captured-money checks remain the
 * responsibility of each consumer. It neither rewrites the event nor grants
 * collection/credit authority, and it does not accept other Clover releases.
 */
export function isSupportedStripeSnapshotVersion(snapshotVersion: unknown, resourceApiVersion: unknown): boolean {
  return resourceApiVersion === "2025-10-29.clover" &&
    (snapshotVersion === "2025-09-30.clover" || snapshotVersion === "2025-10-29.clover");
}
