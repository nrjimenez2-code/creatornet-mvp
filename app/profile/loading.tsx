export default function LoadingProfile() {
    return (
      <div className="p-6">
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-full bg-gray-200 animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-48 rounded bg-gray-200 animate-pulse" />
            <div className="h-4 w-72 rounded bg-gray-100 animate-pulse" />
          </div>
        </div>
  
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-48 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }
  