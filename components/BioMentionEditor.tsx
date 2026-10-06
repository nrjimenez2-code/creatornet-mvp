"use client";

import { apiFetch as fetch } from '@/lib/apiFetch';
import { useEffect, useRef, useState } from "react";
import { activeBioMention, replaceBioMention, type BioMention, type MentionAccount } from "@/lib/profileBio";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import styles from "./bio-mention-editor.module.css";

export default function BioMentionEditor({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [token, setToken] = useState<BioMention | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; accounts: MentionAccount[] } | null>(null);
  const [selected, setSelected] = useState(0);
  const key = token && focused && !disabled ? `${token.start}:${token.end}:${token.username}` : "";
  const query = token?.username ?? "";
  const accounts = key && dismissed !== key && result?.key === key ? result.accounts : [];

  useEffect(() => {
    if (!key || dismissed === key) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/profile/mention-suggestions?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Suggestions unavailable");
        const body = await response.json() as { accounts: MentionAccount[] };
        if (!controller.signal.aborted) setResult({ key, accounts: body.accounts.slice(0, 5) });
      } catch {
        if (!controller.signal.aborted) setResult({ key, accounts: [] });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, query, dismissed]);

  function updateToken(element: HTMLTextAreaElement) {
    const next = element.selectionStart === element.selectionEnd ? activeBioMention(element.value, element.selectionStart) : null;
    if (next?.start === token?.start && next?.end === token?.end && next?.username === token?.username) return;
    setToken(next);
    setSelected(0);
  }

  function choose(account: MentionAccount) {
    const element = input.current;
    if (!element || disabled || !accounts.some(candidate => candidate.id === account.id)) return;
    const current = activeBioMention(element.value, element.selectionStart);
    if (!current || !token || current.start !== token.start || current.end !== token.end || current.username !== token.username) return;
    const next = replaceBioMention(element.value, current, account.username);
    if (!next) return;
    onChange(next.text);
    setToken(null);
    setResult(null);
    setDismissed(`${current.start}:${next.cursor}:${account.username}`);
    // Commit the controlled value before restoring selection.
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.cursor, next.cursor);
    });
  }

  return <div onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <textarea ref={input} id="profile-bio" name="bio" value={value} disabled={disabled} rows={4} maxLength={600}
      aria-describedby="bio-count bio-mention-help" aria-autocomplete="list" aria-controls={accounts.length ? "bio-mention-list" : undefined}
      aria-activedescendant={accounts.length ? `bio-mention-${selected}` : undefined}
      onChange={event => { setDismissed(null); onChange(event.target.value); updateToken(event.currentTarget); }}
      onSelect={event => updateToken(event.currentTarget)}
      onFocus={event => { setFocused(true); updateToken(event.currentTarget); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && key) { event.preventDefault(); setDismissed(key); return; }
        if (!accounts.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + accounts.length) % accounts.length);
        } else if (event.key === "Enter") { event.preventDefault(); choose(accounts[selected]); }
      }} />
    {accounts.length ? <div id="bio-mention-list" role="listbox" aria-label="Matching accounts" className={styles.list}>
      {accounts.map((account, index) => <button type="button" role="option" aria-selected={index === selected}
        id={`bio-mention-${index}`} key={account.id} tabIndex={-1} className={styles.option}
        onPointerDown={event => event.preventDefault()} onClick={() => choose(account)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={account.avatar_url || DEFAULT_AVATAR_URL} alt="" width={32} height={32} />
        <span><strong>@{account.username}</strong>{account.full_name ? <span>{account.full_name}</span> : null}</span>
      </button>)}
    </div> : null}
    <p id="bio-mention-help" className={styles.help}>Type @ to mention an account.</p>
    {accounts.length ? <span role="status" aria-live="polite" className="sr-only">{accounts.length} matching accounts. Use the arrow keys and Enter to select.</span> : null}
  </div>;
}
