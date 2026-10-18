// SPDX-License-Identifier: GPL-3.0-or-later
"use client";
// The Overview's one loud thing, as the Android HeroJar: the month as a jar
// holding two liquids, income floating at the top and spending settled at the
// bottom, the savings the space between them, to scale. The geometry is
// lib/jar.ts; this only draws it and runs the clock.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FIGURE_MS, LIQUID_MS, emulsion, figureTop, jarFrame, jarPaths, type Hero } from "@/lib/jar";

const WIDTH = 384;
const HEIGHT = 300;
const BUBBLES = emulsion();

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** The time since the levels last changed, 0..LIQUID_MS, ticking once per frame; at rest at once with reduced motion. */
function useLiquidClock(key: string): number {
  const [ms, setMs] = useState(() => (reducedMotion() ? LIQUID_MS : 0));
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (reducedMotion()) {
      setMs(LIQUID_MS);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(now - start, LIQUID_MS);
      setMs(t);
      if (t < LIQUID_MS) frame.current = requestAnimationFrame(tick);
    };
    setMs(0);
    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [key]);
  return ms;
}

export function HeroJar({ hero, money, description }: {
  hero: Hero;
  /** The household's currency format. */
  money: (minor: number) => string;
  /** What the jar says, for a screen reader: "September 2026: $X in, $Y out, $Z left." */
  description: string;
}) {
  const ms = useLiquidClock(`${hero.incomeFraction}:${hero.expenseFraction}`);
  const uid = useId().replace(/:/g, "");
  const j = useMemo(() => jarFrame(WIDTH, HEIGHT, hero.incomeFraction, hero.expenseFraction, ms / LIQUID_MS, ms), [hero.incomeFraction, hero.expenseFraction, ms]);
  const p = jarPaths(j);
  const deficit = hero.savingsMinor < 0;
  const overIncome = deficit || j.mixed;
  const shown = ms >= FIGURE_MS ? hero.savingsMinor : Math.trunc(hero.savingsMinor * (ms / FIGURE_MS));
  const inner = { x: j.side, y: j.top, w: WIDTH - 2 * j.side, h: j.bottom - j.top };
  const depth = j.incomeLevel - j.expenseLevel + 24;

  return (
    <div className="px-2 py-2" role="img" aria-label={description} data-testid="hero-jar" data-mixed={j.mixed ? "true" : "false"}>
      <div className="relative">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block w-full h-auto" aria-hidden>
        <defs>
          <clipPath id={`jar-${uid}`}><rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} rx={j.radius} /></clipPath>
          <linearGradient id={`in-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={j.top} y2={Math.max(j.incomeLevel, j.top + 1)}>
            <stop offset="0" stopColor="var(--in-body)" /><stop offset="1" stopColor="var(--in-surface)" />
          </linearGradient>
          <linearGradient id={`out-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={Math.min(j.expenseLevel, j.bottom - 1)} y2={j.bottom}>
            <stop offset="0" stopColor="var(--out-surface)" /><stop offset="1" stopColor="var(--out-body)" />
          </linearGradient>
          {p.band && (
            <>
              <clipPath id={`band-${uid}`}><path d={p.band} /></clipPath>
              <linearGradient id={`mix-${uid}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={j.expenseLevel} y2={Math.max(j.incomeLevel, j.expenseLevel + 1)}>
                <stop offset="0" stopColor="var(--in-surface)" /><stop offset="1" stopColor="var(--out-surface)" />
              </linearGradient>
            </>
          )}
        </defs>
        <g clipPath={`url(#jar-${uid})`}>
          <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill="var(--paper-high)" />
          <path d={p.income} fill={`url(#in-${uid})`} />
          <path d={p.expense} fill={`url(#out-${uid})`} />
          {p.band && (
            <g clipPath={`url(#band-${uid})`} data-testid="jar-deficit">
              <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill={`url(#mix-${uid})`} />
              {BUBBLES.map((b, i) => (
                <circle key={i} cx={j.side + b.x * inner.w} cy={j.expenseLevel - 12 + b.y * depth} r={b.r}
                  fill={b.light ? "var(--in-body)" : "var(--out-body)"} fillOpacity={0.5} />
              ))}
            </g>
          )}
          {/* A light line along each surface is most of what makes a flat colour read as liquid. */}
          <path d={p.incomeLine} transform="translate(0 -2)" fill="none" stroke="#fff" strokeOpacity={0.35} strokeWidth={j.stroke} />
          <path d={p.expenseLine} transform="translate(0 2)" fill="none" stroke="#fff" strokeOpacity={0.3} strokeWidth={j.stroke} />
        </g>
        <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} rx={j.radius} fill="none" stroke="var(--line)" strokeWidth={j.stroke} />
      </svg>
      <div className="absolute inset-x-6 text-center pointer-events-none" style={{ top: `${(figureTop(j, deficit) / HEIGHT) * 100}%` }}>
        {/* Over the income liquid the figure is drawn in paper, which inverts with the liquid in both themes. */}
        <div className={`t-hero truncate ${overIncome ? "text-paper" : "text-ink"}`} data-testid="jar-figure">{money(shown)}</div>
      </div>
      </div>
    </div>
  );
}
