"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BookingConnectionSkeleton } from "@/components/loading/Skeletons";
function Complete() {
  const result = useSearchParams().get("result");
  return <main className="mx-auto max-w-lg space-y-4 p-8 text-white">
    <h1 className="text-xl font-semibold">{result === "connected" ? "Connection complete" : result === "canceled" ? "Connection canceled" : "Connection needs another attempt"}</h1>
    <p>{result === "connected" ? "Your booking provider is saved. Return to CreatorNet to choose your event." : "Return to CreatorNet to check the connection or try again. Your post draft is still there."}</p>
    <button type="button" className="rounded bg-white px-4 py-2 text-black" onClick={() => window.close()}>Return to CreatorNet</button>
    <p className="text-sm">If this window stays open, switch back to your original CreatorNet tab.</p>
  </main>;
}
export default function CompletePage() { return <Suspense fallback={<BookingConnectionSkeleton complete />}><Complete /></Suspense>; }
