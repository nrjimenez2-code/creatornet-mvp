import Link from "next/link";

// Explicit light background: the root body is bg-black with text-gray-900, so
// any page that doesn't set its own colors renders dark-on-dark.
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <nav aria-label="Legal pages" className="mb-10 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Link href="/dashboard" className="font-semibold text-[#655BFF] hover:underline">
            ← CreatorNet
          </Link>
          <span aria-hidden className="text-gray-300">|</span>
          <Link href="/legal/terms" className="text-gray-600 hover:text-gray-900 hover:underline">
            Terms of Service
          </Link>
          <Link href="/legal/privacy" className="text-gray-600 hover:text-gray-900 hover:underline">
            Privacy Policy
          </Link>
          <Link href="/legal/cookies" className="text-gray-600 hover:text-gray-900 hover:underline">
            Cookies Policy
          </Link>
        </nav>
        {children}
        <footer className="mt-14 border-t border-gray-200 pt-6 text-sm text-gray-500">
          <p>
            Questions? Email{" "}
            <a href="mailto:support@creatornet.net" className="underline">
              support@creatornet.net
            </a>
            .
          </p>
        </footer>
      </div>
    </div>
  );
}
