// SPDX-License-Identifier: GPL-3.0-or-later
// Fulla's components (app/.../ui/components/Pieces.kt): headers, sections,
// rows, chips, buttons. If two screens need the same thing, it is here.
import { Check } from "lucide-react";
import type { ReactNode } from "react";

/** A member's colour (IdentityColors.members), always with their initials. */
export function memberColor(index: number): string {
  return `var(--m${((index % 10) + 10) % 10})`;
}

/** A category's colour (IdentityColors.categories, twelve). */
export function categoryColor(index: number): string {
  const i = ((index % 12) + 12) % 12;
  return i < 10 ? `var(--m${i})` : `var(--c${i})`;
}

export function ScreenHeader({ title, end }: { title: string; end?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 pt-5 pb-3 safe-top">
      <h1 className="t-screen-title">{title}</h1>
      {end}
    </div>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <div className="t-section text-ink-muted uppercase px-5 pt-5 pb-2">{children}</div>;
}

export function Chip({ label, selected, onClick, testId }: { label: string; selected: boolean; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`yields shrink-0 inline-flex items-center gap-1.5 h-10 px-4 rounded-xl border t-section normal-case ${
        selected ? "bg-highlight text-on-highlight border-highlight" : "bg-paper text-ink border-line"
      }`}
    >
      {selected && <Check size={16} strokeWidth={2.5} />}
      {label}
    </button>
  );
}

export function PrimaryButton({ children, onClick, disabled, busy, type = "button", testId }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; type?: "button" | "submit"; testId?: string;
}) {
  return (
    <button
      type={type}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || busy}
      className="yields w-full h-14 rounded-2xl bg-accent text-on-accent t-body font-semibold disabled:opacity-40"
    >
      {busy ? "…" : children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`yields w-full h-12 rounded-2xl border border-line t-body font-medium ${danger ? "text-danger" : "text-ink"}`}>
      {children}
    </button>
  );
}

export function Avatar({ initials, colorIndex }: { initials: string; colorIndex: number }) {
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center t-label text-white shrink-0" style={{ background: memberColor(colorIndex) }}>
      {initials}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block px-5 py-2">
      <span className="t-label text-ink-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export const inputClass = "w-full h-12 px-4 rounded-xl border border-line bg-paper text-ink t-body outline-none focus:border-ink";

export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="px-8 py-16 text-center">
      <div className="t-title">{title}</div>
      <p className="t-secondary text-ink-muted mt-2">{text}</p>
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
