import { Eye } from "lucide-react";
import { formatViewCount, viewCountLabel } from "@/lib/postViewCounts";

export default function VideoViewCount({ count, id }: { count: number | null | undefined; id?: string }) {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-2 pt-5 text-white" data-video-view-count>
      <span className="flex items-center gap-1 text-xs font-medium leading-none" aria-hidden="true">
        <Eye className="h-3.5 w-3.5 shrink-0" />
        {formatViewCount(count)}
      </span>
      <span id={id} className="sr-only">{viewCountLabel(count)}</span>
    </span>
  );
}
