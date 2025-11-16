"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

export default function BackButton() {
  const router = useRouter();

  const handleClick = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={handleClick}
        aria-label="Go back"
        suppressHydrationWarning
        className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="stroke-current"
        >
          <path
            d="M11.5 3.5 6 9l5.5 5.5"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
