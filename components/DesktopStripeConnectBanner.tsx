"use client";

import dynamic from "next/dynamic";
import { useDesktopViewport } from "@/lib/browserVisibility";

const StripeConnectBanner = dynamic(() => import("./StripeConnectBanner"), { loading: () => null });

export default function DesktopStripeConnectBanner() {
  return useDesktopViewport() ? <StripeConnectBanner /> : null;
}
