/** A native local-origin URL cannot be opened by a recipient; use the packaged website origin. */
export function videoShareUrl(postId: string, currentOrigin: string, websiteOrigin: string): string {
  const current = new URL(currentOrigin);
  const site = current.protocol === "capacitor:" ? new URL(websiteOrigin) : current;
  if (current.protocol === "capacitor:" && (site.protocol !== "https:" || site.pathname !== "/" || site.search || site.hash)) {
    throw new Error("A public website origin is required for sharing.");
  }
  return new URL(`/dashboard?postId=${encodeURIComponent(postId)}`, site).href;
}
