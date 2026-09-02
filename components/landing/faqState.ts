// components/landing/faqState.ts — the one rule of the FAQ accordion, kept
// pure so it can be tested without a DOM: at most one answer is open, and
// activating the open one closes it.
export function nextOpenIndex(current: number | null, clicked: number): number | null {
  return current === clicked ? null : clicked;
}
