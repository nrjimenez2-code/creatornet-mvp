"use client";

/** Fail closed: unavailable money data is never substituted with empty rows. */
export default function CommerceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section role="alert" className="rounded-2xl border border-[#e9e3f7] bg-white p-6 shadow-sm">
      <h1 className="text-xl font-black text-zinc-900">Commerce is temporarily unavailable</h1>
      <p className="mt-2 max-w-xl text-sm text-gray-500">
        We couldn’t load the payment records. Refund controls are unavailable until the data loads successfully.
        If you already submitted a refund, check its recorded status before submitting anything again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-xl bg-[#9370DB] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#7c5cbf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2"
      >
        Reload payment records
      </button>
    </section>
  );
}
