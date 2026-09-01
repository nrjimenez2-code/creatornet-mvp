export default function LoadingAccess() {
  return (
    <main className="min-h-svh bg-white p-8">
      <div className="max-w-xl mx-auto">
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="mt-4 rounded-2xl border border-gray-200 p-5 space-y-4">
          <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          <div className="h-10 w-full rounded bg-gray-100 animate-pulse" />
          <div className="h-9 w-40 rounded bg-gray-100 animate-pulse" />
        </div>
      </div>
    </main>
  );
}
