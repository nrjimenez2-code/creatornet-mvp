'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import styles from './analytics.module.css';

type Option = { value: string; label: string };
type Props = { id: string; label: string; value: string; options: readonly Option[]; disabled?: boolean; onChange: (value: string) => void };

export default function AnalyticsSelect({ id, label, value, options, disabled = false, onChange }: Props) {
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef({ text: '', time: 0 });
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [expanded]);

  useEffect(() => {
    const item = list.current?.children[active] as HTMLElement | undefined;
    const menu = list.current;
    if (!expanded || !item || !menu) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
  }, [active, expanded]);

  const choose = (index: number) => {
    setOpen(false);
    button.current?.focus();
    if (options[index].value !== value) onChange(options[index].value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (expanded) choose(active);
      else { setActive(selected); setOpen(true); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : !expanded ? selected : Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
      setOpen(true);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - search.current.time < 600 ? search.current.text : '') + event.key.toLowerCase();
      search.current = { text, time: now };
      const index = options.findIndex(option => option.label.toLowerCase().startsWith(text));
      if (index >= 0) { setActive(index); setOpen(true); }
    }
  };

  return <div ref={root} className={styles.selectRoot}>
    <button ref={button} id={id} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={`${id}-options`} aria-activedescendant={expanded ? `${id}-option-${active}` : undefined} disabled={disabled} className={styles.selectTrigger} onKeyDown={onKeyDown} onClick={() => { setActive(selected); search.current = { text: '', time: 0 }; setOpen(!expanded); }}>
      <span>{options[selected].label}</span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {expanded && <ul ref={list} id={`${id}-options`} role="listbox" aria-label={label} className={styles.selectOptions}>
      {options.map((option, index) => <li key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} data-active={index === active} className={styles.selectOption} onMouseMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>{option.label}</li>)}
    </ul>}
  </div>;
}
