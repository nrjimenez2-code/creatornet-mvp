// app/success/page.tsx  (SERVER component only)

// These route-segment options must live on the **server** file:
export const dynamic = "force-dynamic"; // always render on server
export const revalidate = 0;             // disable ISR for this page

import SuccessClient from "./SuccessClient";

export default function Page() {
  return <SuccessClient />;
}
