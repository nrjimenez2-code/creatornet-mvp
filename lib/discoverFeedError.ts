export const DISCOVER_SESSION_UNAVAILABLE = "DISCOVER_SESSION_UNAVAILABLE";

/** The current snapshot cannot be continued; a new snapshot needs an explicit refresh. */
export class DiscoverSessionUnavailableError extends Error {
  readonly code = DISCOVER_SESSION_UNAVAILABLE;
  constructor() {
    super("This feed needs to be refreshed.");
    this.name = "DiscoverSessionUnavailableError";
  }
}
