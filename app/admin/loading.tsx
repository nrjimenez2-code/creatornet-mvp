export default function LoadingAdmin() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-48 rounded bg-gray-200 animate-pulse" />
        <div className="mt-2 h-4 w-72 rounded bg-gray-100 animate-pulse" />
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl border border-gray-200 bg-white animate-pulse" />
        ))}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-gray-100 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
