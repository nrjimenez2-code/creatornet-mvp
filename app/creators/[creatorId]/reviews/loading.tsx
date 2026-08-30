export default function LoadingCreatorReviews() {
  return (
    <div className="min-h-svh bg-black p-6">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-full bg-white/10 animate-pulse" />
        <div className="space-y-2">
          <div className="h-5 w-40 rounded bg-white/10 animate-pulse" />
          <div className="h-4 w-24 rounded bg-white/5 animate-pulse" />
        </div>
      </div>

      <div className="mt-8 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4 animate-pulse">
            <div className="h-4 w-32 rounded bg-white/10" />
            <div className="mt-3 h-4 w-full rounded bg-white/5" />
            <div className="mt-2 h-4 w-2/3 rounded bg-white/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
