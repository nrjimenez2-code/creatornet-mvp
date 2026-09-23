"use client";

import dynamic from "next/dynamic";
import { useDesktopViewport } from "@/lib/browserVisibility";
import { Skeleton } from "@/components/loading/Skeletons";

const StripeConnectBanner = dynamic(() => import("./StripeConnectBanner"), { loading: () => <Skeleton className="block h-24 w-full rounded-xl border border-white/20" /> });

export default function DesktopStripeConnectBanner() {
  return useDesktopViewport() ? <StripeConnectBanner /> : null;
}
