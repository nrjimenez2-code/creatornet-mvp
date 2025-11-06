export default function LoadingClosers() {
    return (
      <div className="p-6 space-y-6 animate-pulse">
        <div className="h-8 w-40 bg-gray-200 rounded" />
  
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border bg-white p-4 shadow-sm flex justify-between items-center"
            >
              <div className="h-6 w-32 bg-gray-200 rounded" />
              <div className="h-6 w-20 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  