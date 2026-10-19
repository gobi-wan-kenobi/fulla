// SPDX-License-Identifier: GPL-3.0-or-later
// The budget of the month, as the Android home screen's row: what the
// budgeted categories used against what they allow, left or over, and a thin
// line that fills with it (ProgressLine): ink, amber from 80 %, red once over.
import { ChevronRight } from "lucide-react";
import { type BudgetStatus, type BudgetTone, budgetTone } from "@/lib/budgets";

const FILL: Record<BudgetTone, string> = { ok: "bg-ink", near: "bg-warning", over: "bg-danger" };
const TEXT: Record<BudgetTone, string> = { ok: "text-ink-muted", near: "text-warning", over: "text-danger" };

/** The words for a budget's state: "$X left of $Y" or "$X over budget". */
export function budgetWords(s: BudgetStatus, money: (n: number) => string): string {
  return s.overMinor > 0 ? `${money(s.overMinor)} over budget` : `${money(s.leftMinor)} left of ${money(s.limitMinor)}`;
}

export function toneText(s: BudgetStatus | null, tone?: BudgetTone): string {
  return s ? TEXT[tone ?? budgetTone(s)] : "text-ink-muted";
}

/** A 4 px line on the rule colour, filled to fraction (0..1); amber from 80 %, red once over. */
export function ProgressLine({ status, fraction, tone: given, muted, testId }: {
  status?: BudgetStatus | null; fraction?: number; tone?: BudgetTone; /** Against what is usual, not a budget: a quiet fill. */ muted?: boolean; testId?: string;
}) {
  const f = status ? status.fraction : (fraction ?? 0);
  const tone: BudgetTone = given ?? (status ? budgetTone(status) : "ok");
  const width = Math.round(Math.min(1, Math.max(0, f)) * 1000) / 10;
  return (
    <div className="h-1 rounded-full bg-line overflow-hidden my-1.5" data-testid={testId} data-tone={tone}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.max(0, f) * 100)}>
      <div className={`h-full rounded-full transition-[width] duration-[420ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${muted ? "bg-ink-muted opacity-60" : FILL[tone]}`}
        style={{ width: `${width}%` }} />
    </div>
  );
}

export function BudgetBar({ status, money, onOpen }: { status: BudgetStatus | null; money: (minor: number) => string; onOpen?: () => void }) {
  const body = (
    <>
      <div className="flex-1 min-w-0">
        <div className="t-body">Budget for the month</div>
        {status ? (
          <>
            <div className={`t-secondary ${toneText(status)}`} data-testid="budget-context">{budgetWords(status, money)}</div>
            <ProgressLine status={status} testId="budget-line" />
          </>
        ) : (
          <div className="t-secondary text-ink-muted" data-testid="budget-context">
            No budget set yet · <span className="underline text-ink">Set a budget</span>
          </div>
        )}
      </div>
      {onOpen && <ChevronRight size={20} className="text-ink-muted shrink-0" aria-hidden />}
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className="w-full flex items-center gap-3 px-5 py-3 border-b border-line text-left yields" data-testid="budget-bar">{body}</button>
  ) : (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-line" data-testid="budget-bar">{body}</div>
  );
}
