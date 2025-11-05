// app/cancel/page.tsx

export const metadata = {
  title: "Payment canceled | CreatorNet",
  description: "Your checkout was canceled.",
};

// Static is fine here
export const dynamic = "force-static";
export const revalidate = false as const;

export default function CancelPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full border rounded-xl p-6 text-center">
        <h1 className="text-xl font-semibold mb-2">Payment canceled</h1>
        <p className="text-sm text-gray-600 mb-6">
          No charge was made. You can close this page or go back and try again.
        </p>
        <div className="flex items-center justify-center gap-3">
          <a href="/" className="px-4 py-2 rounded-md border hover:bg-gray-50 text-sm">
            Back home
          </a>
          <a href="/library" className="px-4 py-2 rounded-md bg-black text-white text-sm hover:opacity-90">
            View Library
          </a>
        </div>
      </div>
    </main>
  );
}
