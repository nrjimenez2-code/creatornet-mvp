export default function LoadingCreatorProfile() {
  return (
    <div className="min-h-svh bg-black p-6">
      <div className="flex items-center gap-4">
        <div className="h-32 w-32 rounded-full bg-white/10 animate-pulse" />
        <div className="space-y-3">
          <div className="h-6 w-48 rounded bg-white/10 animate-pulse" />
          <div className="h-4 w-64 rounded bg-white/5 animate-pulse" />
          <div className="h-4 w-40 rounded bg-white/5 animate-pulse" />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="aspect-square border border-white/10 bg-white/5 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
