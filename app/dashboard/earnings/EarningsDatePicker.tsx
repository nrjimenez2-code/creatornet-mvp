"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { shiftCalendarDate, validCalendarDate } from "@/lib/earningsPeriod";
import styles from "./earnings.module.css";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const minimumDate = "2000-01-01";
const maximumDate = "2100-12-31";
const fullDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthTitle = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function browserToday() {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

function moveMonth(value: string, months: number) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  const date = target.toISOString().slice(0, 10);
  return date < minimumDate ? minimumDate : date > maximumDate ? maximumDate : date;
}

function parseInput(value: string) {
  if (validCalendarDate(value)) return value;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) return value;
  const date = `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return validCalendarDate(date) ? date : value;
}

function displayInput(value: string) {
  return validCalendarDate(value) ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` : value;
}

function Chevron({ direction, double = false }: { direction: "previous" | "next"; double?: boolean }) {
  const path = direction === "previous" ? "m10 3-5 5 5 5" : "m6 3 5 5-5 5";
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={path} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />{double && <path d={path} transform={`translate(${direction === "previous" ? -4 : 4} 0)`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}</svg>;
}

export default function EarningsDatePicker({ id, label, value, disabled, onChange }: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(validCalendarDate(value) ? value : minimumDate);
  const [today, setToday] = useState("");
  const [left, setLeft] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const focusDay = useRef(false);
  const expanded = open && !disabled;
  const firstOfMonth = `${active.slice(0, 7)}-01`;
  const firstGridDate = shiftCalendarDate(firstOfMonth, -new Date(`${firstOfMonth}T00:00:00Z`).getUTCDay());
  const days = Array.from({ length: 42 }, (_, index) => shiftCalendarDate(firstGridDate, index));

  const positionPopover = useCallback(() => {
    if (!root.current) return;
    const anchor = root.current.getBoundingClientRect().left;
    const width = Math.min(284, window.innerWidth - 32);
    setLeft(Math.max(16, Math.min(anchor, window.innerWidth - width - 16)) - anchor);
  }, []);

  function openCalendar() {
    if (disabled) return;
    const date = browserToday();
    setToday(date);
    setActive(validCalendarDate(value) ? value : date);
    positionPopover();
    focusDay.current = true;
    setOpen(true);
  }

  function closeCalendar() {
    setOpen(false);
    input.current?.focus();
  }

  function choose(date: string) {
    onChange(date);
    closeCalendar();
  }

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", positionPopover);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("resize", positionPopover);
    };
  }, [expanded, positionPopover]);

  useEffect(() => {
    if (!expanded || !focusDay.current) return;
    focusDay.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus();
  }, [active, expanded]);

  function navigateGrid(event: KeyboardEvent<HTMLTableElement>) {
    let next: string;
    const weekday = new Date(`${active}T00:00:00Z`).getUTCDay();
    switch (event.key) {
      case "ArrowLeft": next = shiftCalendarDate(active, -1); break;
      case "ArrowRight": next = shiftCalendarDate(active, 1); break;
      case "ArrowUp": next = shiftCalendarDate(active, -7); break;
      case "ArrowDown": next = shiftCalendarDate(active, 7); break;
      case "Home": next = shiftCalendarDate(active, -weekday); break;
      case "End": next = shiftCalendarDate(active, 6 - weekday); break;
      case "PageUp": next = moveMonth(active, event.shiftKey ? -12 : -1); break;
      case "PageDown": next = moveMonth(active, event.shiftKey ? 12 : 1); break;
      case "Enter": case " ": event.preventDefault(); choose(active); return;
      default: return;
    }
    event.preventDefault();
    if (!validCalendarDate(next) || next === active) return;
    focusDay.current = true;
    setActive(next);
  }

  return (
    <div ref={root} className={styles.dateField} onKeyDown={(event) => {
      if (expanded && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCalendar(); }
    }}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.dateInputRow}>
        <input ref={input} id={id} type="text" role="combobox" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={`${id}-calendar`} aria-autocomplete="none" aria-describedby={`${id}-format`} aria-invalid={value !== "" && !validCalendarDate(value) || undefined} value={displayInput(value)} placeholder="MM/DD/YYYY" autoComplete="off" required disabled={disabled} onChange={(event) => onChange(parseInput(event.target.value))} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); openCalendar(); }
        }} />
        <button type="button" tabIndex={-1} className={styles.dateToggle} aria-label={`Choose ${label.toLowerCase()} date`} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={`${id}-calendar`} disabled={disabled} onClick={() => expanded ? closeCalendar() : openCalendar()}>
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M6 2v4m8-4v4M3 8h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <span id={`${id}-format`} className={styles.screenReaderOnly}>Date format: MM/DD/YYYY. In the calendar, use arrow keys for days and weeks, Page Up or Down for months, and Shift with Page Up or Down for years.</span>
      {expanded && (
        <div id={`${id}-calendar`} role="dialog" aria-label={`Choose ${label.toLowerCase()} date`} className={styles.datePopover} style={{ left }}>
          <div className={styles.calendarHeader}>
            <button type="button" className={styles.calendarControl} aria-label="Previous year" disabled={active.slice(0, 4) === "2000"} onClick={() => setActive(moveMonth(active, -12))}><Chevron direction="previous" double /></button>
            <button type="button" className={styles.calendarControl} aria-label="Previous month" disabled={active.slice(0, 7) === "2000-01"} onClick={() => setActive(moveMonth(active, -1))}><Chevron direction="previous" /></button>
            <h2 id={`${id}-month`} aria-live="polite">{monthTitle.format(new Date(`${firstOfMonth}T00:00:00Z`))}</h2>
            <button type="button" className={styles.calendarControl} aria-label="Next month" disabled={active.slice(0, 7) === "2100-12"} onClick={() => setActive(moveMonth(active, 1))}><Chevron direction="next" /></button>
            <button type="button" className={styles.calendarControl} aria-label="Next year" disabled={active.slice(0, 4) === "2100"} onClick={() => setActive(moveMonth(active, 12))}><Chevron direction="next" double /></button>
          </div>
          <table ref={grid} role="grid" aria-labelledby={`${id}-month`} className={styles.calendarGrid} onKeyDown={navigateGrid}>
            <thead><tr>{weekdays.map((day) => <th key={day} scope="col" abbr={day}>{day.slice(0, 2)}</th>)}</tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{days.slice(week * 7, week * 7 + 7).map((date) => (
              <td key={date} aria-selected={date === value ? true : undefined}>
                <button type="button" className={styles.calendarDay} data-date={date} data-outside={date.slice(0, 7) !== active.slice(0, 7)} data-selected={date === value} aria-label={fullDate.format(new Date(`${date}T00:00:00Z`))} aria-current={date === today ? "date" : undefined} tabIndex={date === active ? 0 : -1} disabled={!validCalendarDate(date)} onClick={() => choose(date)}>{Number(date.slice(8, 10))}</button>
              </td>
            ))}</tr>)}</tbody>
          </table>
          <div className={styles.calendarFooter}>
            <button type="button" className={styles.calendarControl} onClick={() => choose("")}>Clear</button>
            <button type="button" className={styles.calendarControl} onClick={() => choose(browserToday())}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
