export default function LoadingAnalytics() {
    return (
      <div className="p-6 space-y-8">
        <div>
          <div className="h-8 w-40 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-72 bg-gray-200 rounded mt-2 animate-pulse" />
        </div>
  
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border bg-white p-4 shadow-sm flex flex-col gap-3 animate-pulse"
            >
              <div className="h-4 w-24 bg-gray-200 rounded" />
              <div className="h-6 w-20 bg-gray-300 rounded" />
            </div>
          ))}
        </div>
  
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="h-6 w-32 bg-gray-200 rounded mb-4 animate-pulse" />
          <div className="h-72 w-full bg-gray-100 rounded animate-pulse" />
        </div>
      </div>
    );
  }
  