"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

export default function InstallmentLinkForm({ disabled, onGenerate }: {
  disabled: boolean;
  onGenerate: (months: number) => Promise<boolean>;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const submittingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = disabled || submitting;

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (wasOpenRef.current) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  const close = () => {
    if (!busy && !submittingRef.current) setOpen(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submittingRef.current) return;
    const count = Number(months);
    if (!Number.isInteger(count) || count < 2 || count > 24) {
      setError("Enter a whole number from 2 to 24.");
      inputRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (await onGenerate(count)) setOpen(false);
    } catch {
      setError("Unable to generate the link. Please try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-form`}
        disabled={busy}
        className="rounded-full bg-gray-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9370DB]"
        onClick={() => {
          if (open) close();
          else {
            setMonths("3");
            setError(null);
            setOpen(true);
          }
        }}
      >
        Generate installment link
      </button>
      {open && (
        <form
          id={`${id}-form`}
          aria-label="Installment payment plan"
          aria-busy={busy}
          noValidate
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="basis-full rounded-xl border border-white/20 bg-white/5 p-4 text-sm"
        >
          <label htmlFor={`${id}-months`} className="block font-medium text-white">
            Number of monthly payments
          </label>
          <p id={`${id}-help`} className="mt-1 text-xs text-white/60">
            Choose 2–24 payments. Creating a link does not charge the buyer.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              id={`${id}-months`}
              type="number"
              inputMode="numeric"
              min={2}
              max={24}
              step={1}
              required
              value={months}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
              onChange={(event) => {
                setMonths(event.target.value);
                setError(null);
              }}
              className="w-24 rounded-lg border border-white/30 bg-black px-3 py-2 text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB]"
            />
            <button type="submit" disabled={busy} className="rounded-full bg-[#4A35C7] px-4 py-2 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9370DB]">
              {submitting ? "Creating…" : "Create installment link"}
            </button>
            <button type="button" disabled={busy} onClick={close} className="rounded-full border border-white/30 px-4 py-2 text-white/80 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9370DB]">
              Cancel
            </button>
          </div>
          {error && <p id={`${id}-error`} role="alert" className="mt-3 text-red-300">{error}</p>}
        </form>
      )}
    </>
  );
}
