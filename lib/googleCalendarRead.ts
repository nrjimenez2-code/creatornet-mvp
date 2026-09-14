import "server-only";
import { googleConnectionAccessToken, refreshRejectedGoogleAccessToken } from "@/lib/googleCalendarConnection";
import { GoogleCalendarError } from "@/lib/googleCalendarProvider";

/** Retry read-only requests once; event mutations retain their durable job recovery. */
export async function readWithGoogleAccessToken<T>(connectionId: string, read: (token: string) => Promise<T>): Promise<T> {
  const token = await googleConnectionAccessToken(connectionId);
  try {
    return await read(token);
  } catch (cause) {
    if (!(cause instanceof GoogleCalendarError) || cause.status !== 401) throw cause;
    await refreshRejectedGoogleAccessToken(connectionId, token);
    // Re-read under the connection lease: a concurrent reconnect may have replaced the token.
    return read(await googleConnectionAccessToken(connectionId));
  }
}
