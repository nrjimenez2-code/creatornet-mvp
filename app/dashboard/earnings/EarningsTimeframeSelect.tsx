"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EarningsPreset } from "@/lib/earningsPeriod";
import styles from "./earnings.module.css";

const options: { value: EarningsPreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this-week", label: "This Week" },
  { value: "this-month", label: "This Month" },
  { value: "custom", label: "Custom Range" },
];

export default function EarningsTimeframeSelect({ value, disabled, onChange }: {
  value: EarningsPreset;
  disabled: boolean;
  onChange: (value: EarningsPreset) => void;
}) {
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef({ text: "", time: 0 });
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [expanded]);

  useEffect(() => {
    const item = list.current?.children[active] as HTMLElement | undefined;
    const menu = list.current;
    if (!expanded || !item || !menu) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
  }, [active, expanded]);

  function choose(index: number) {
    setOpen(false);
    trigger.current?.focus();
    if (options[index].value !== value) onChange(options[index].value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(active);
      else { setActive(selected); search.current = { text: "", time: 0 }; setOpen(true); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : !expanded ? selected : Math.max(0, Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
      search.current = { text: "", time: 0 };
      setOpen(true);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - search.current.time < 600 ? search.current.text : "") + event.key.toLowerCase();
      search.current = { text, time: now };
      const prefix = [...text].every((character) => character === text[0]) ? text[0] : text;
      const start = prefix.length === 1 ? (expanded ? active : selected) + 1 : 0;
      const index = options.findIndex((_, offset) => options[(start + offset) % options.length].label.toLowerCase().startsWith(prefix));
      if (index >= 0) { setActive((start + index) % options.length); setOpen(true); }
    }
  }

  return (
    <div ref={root} className={styles.timeframeSelect}>
      <button ref={trigger} id="earnings-period" type="button" role="combobox" aria-label="Timeframe" aria-haspopup="listbox" aria-expanded={expanded} aria-controls="earnings-period-options" aria-activedescendant={expanded ? `earnings-period-option-${active}` : undefined} disabled={disabled} className={styles.timeframeTrigger} onKeyDown={onKeyDown} onClick={() => { setActive(selected); search.current = { text: "", time: 0 }; setOpen(!expanded); }}>
        <span>{options[selected].label}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {expanded && (
        <ul ref={list} id="earnings-period-options" role="listbox" aria-label="Timeframe" className={styles.timeframeOptions}>
          {options.map((option, index) => (
            <li key={option.value} id={`earnings-period-option-${index}`} role="option" aria-selected={option.value === value} data-active={index === active} className={styles.timeframeOption} onMouseMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
              <span>{option.label}</span>
              {option.value === value && <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
