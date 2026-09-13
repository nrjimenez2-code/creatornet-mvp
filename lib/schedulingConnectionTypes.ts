export type BookingProvider = "calcom" | "calendly" | "google";
export const BOOKING_PROVIDER_NAMES: Record<BookingProvider, string> = { calcom: "Cal.com", calendly: "Calendly", google: "Google Calendar" };
export type BookingConnectionStatus = {
  provider: BookingProvider;
  available: boolean;
  status: "disconnected" | "pending" | "connected" | "reconnect_required" | "disconnecting" | "error";
  accountName: string | null;
  eventTypes: { id: string; title: string; bookingUrl: string }[];
};

export function bookingProviderForUrl(value: string): BookingProvider | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.hostname === "cal.com" || url.hostname.endsWith(".cal.com")) return "calcom";
    if (url.hostname === "calendly.com" || url.hostname.endsWith(".calendly.com")) return "calendly";
  } catch { /* An incomplete URL has no provider yet. */ }
  return null;
}

export function isBookingProvider(value: unknown): value is BookingProvider { return value === "calcom" || value === "calendly" || value === "google"; }
