// SPDX-License-Identifier: GPL-3.0-or-later
// The budget of the month, as the Android home screen's row: what the
// budgeted categories used against what they allow, left or over, and a thin
// line that fills with it (ProgressLine): money-out, danger once over.
import type { BudgetStatus } from "@/lib/budgets";

/** A 4 px line on the rule colour, filled to fraction (0..1); danger once over. */
export function ProgressLine({ fraction, over, testId }: { fraction: number; over: boolean; testId?: string }) {
  const width = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
  return (
    <div className="h-1 rounded-full bg-line overflow-hidden my-1.5" data-testid={testId} data-over={over ? "true" : "false"}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.max(0, fraction) * 100)}>
      <div className={`h-full rounded-full transition-[width] duration-[420ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${over ? "bg-danger" : "bg-money-out"}`}
        style={{ width: `${width}%` }} />
    </div>
  );
}

export function BudgetBar({ status, money }: { status: BudgetStatus | null; money: (minor: number) => string }) {
  return (
    <div className="px-5 py-3 border-b border-line" data-testid="budget-bar">
      <div className="t-body">Budget for the month</div>
      {status ? (
        <>
          <div className={`t-secondary ${status.overMinor > 0 ? "text-danger" : "text-ink-muted"}`} data-testid="budget-context">
            {status.overMinor > 0 ? `${money(status.overMinor)} over budget` : `${money(status.leftMinor)} left of ${money(status.limitMinor)}`}
          </div>
          <ProgressLine fraction={status.fraction} over={status.overMinor > 0} testId="budget-line" />
        </>
      ) : (
        <>
          <div className="t-secondary text-ink-muted" data-testid="budget-context">No budget set yet · budgets can be set in the Android app for now</div>
          <ProgressLine fraction={0} over={false} testId="budget-line" />
        </>
      )}
    </div>
  );
}
