export default function LoadingLibrary() {
    return (
      <div className="p-6 space-y-6 animate-pulse">
        <div className="h-8 w-40 bg-gray-200 rounded" />
  
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-48 bg-gray-200 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  