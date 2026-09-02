"use client";

import { useId, useState } from "react";
import { nextOpenIndex } from "./faqState";

export type FaqItem = { q: string; a: React.ReactNode };

/**
 * Accessible accordion. Only one answer open at a time; each control is a
 * real <button> with aria-expanded/aria-controls, so it already works with a
 * mouse, keyboard (Tab, Enter, Space) and touch with no extra key handling.
 * The 44px touch target comes from .cn-site-question-button's min-height.
 */
export default function Faq({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();

  return (
    <div className="cn-site-questions">
      {items.map((item, i) => {
        const isOpen = open === i;
        const answerId = `${baseId}-answer-${i}`;
        const buttonId = `${baseId}-question-${i}`;
        return (
          <div className="cn-site-question" key={item.q}>
            <h3 style={{ margin: 0, fontSize: "inherit", fontWeight: "inherit" }}>
              <button
                type="button"
                id={buttonId}
                className="cn-site-question-button"
                aria-expanded={isOpen}
                aria-controls={answerId}
                onClick={() => setOpen((cur) => nextOpenIndex(cur, i))}
              >
                <span>{item.q}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </h3>
            <div
              id={answerId}
              role="region"
              aria-labelledby={buttonId}
              className="cn-site-answer"
              hidden={!isOpen}
            >
              {item.a}
            </div>
          </div>
        );
      })}
    </div>
  );
}
