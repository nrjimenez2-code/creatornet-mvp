// app/cancel/page.tsx
import Link from "next/link";

export const metadata = {
  title: "Payment canceled",
  description: "Your checkout was canceled.",
  robots: { index: false, follow: false },
};

// Static is fine here
export const dynamic = "force-static";
export const revalidate = false;

export default function CancelPage() {
  return (
    <main className="min-h-svh bg-white text-gray-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-gray-200 rounded-xl p-6 text-center">
        <h1 className="text-xl font-semibold mb-2">Payment canceled</h1>
        <p className="text-sm text-gray-600 mb-6">
          No charge was made. You can close this page or go back and try again.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link href="/" className="px-4 py-2 rounded-md border hover:bg-gray-50 text-sm">
            Back home
          </Link>
          <a href="/library" className="px-4 py-2 rounded-md bg-black text-white text-sm hover:opacity-90">
            View Library
          </a>
        </div>
        <p className="mt-6 text-xs text-gray-500">
          Questions?{" "}
          <a href="mailto:support@creatornet.net" className="underline hover:text-gray-700">
            support@creatornet.net
          </a>
          {" · "}
          <a href="/legal/refunds" className="underline hover:text-gray-700">
            Refund policy
          </a>
        </p>
      </div>
    </main>
  );
}
