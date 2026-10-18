// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Overview's jar, as the Android home screen draws it (HeroJar.kt, and
 * core's Hero and Liquid): the month as a jar holding two liquids.
 *
 * Income is light and floats at the top; spending is heavy and settles at
 * the bottom. What is left between them is the savings, drawn to scale: the
 * levels are fractions of a field twice the income. When spending passes
 * income the liquids are pressed together and mix, and the mixed band is
 * the deficit.
 *
 * The waves never change how much liquid there is: every surface has a mean
 * of exactly zero. The liquids settle over LIQUID_MS and then stay still;
 * with reduced motion they are drawn at rest at once.
 *
 * Everything here is in CSS pixels (the Android dp), so it can be tested.
 */

export const LIQUID_MS = 420;
export const FIGURE_MS = 300;

export interface Hero {
  incomeMinor: number;
  expenseMinor: number;
  savingsMinor: number;
  /** Income over the field: 0..0.5, less once spending stretches it. */
  incomeFraction: number;
  expenseFraction: number;
  /** The savings' share of the field; negative when spending exceeds income (the overlap). */
  gapFraction: number;
}

/** Income and spending as parts of a field twice the income; only spending beyond that stretches it, so it still fits. */
export function hero(incomeMinor: number, expenseMinor: number): Hero {
  const scale = Math.max(2 * incomeMinor, expenseMinor, 1);
  const incomeFraction = incomeMinor / scale;
  const expenseFraction = expenseMinor / scale;
  return { incomeMinor, expenseMinor, savingsMinor: incomeMinor - expenseMinor, incomeFraction, expenseFraction, gapFraction: 1 - incomeFraction - expenseFraction };
}

/** The mean of a polyline with evenly spaced samples, by the trapezoid rule. */
export function trapezoidMean(y: number[]): number {
  if (y.length < 2) return y[0] ?? 0;
  let sum = 0;
  for (let i = 0; i < y.length - 1; i++) sum += (y[i] + y[i + 1]) / 2;
  return sum / (y.length - 1);
}

/**
 * A liquid's surface, as offsets from its level in fractions of the jar's
 * height (positive downwards), with a mean of exactly zero, meniscus included.
 * meniscus is how far it climbs each wall; positive pulls it up.
 */
export function surface(samples: number, amplitude: number, phase: number, waves: number, meniscus = 0, meniscusWidth = 0.035): number[] {
  if (samples < 2) throw new Error("A surface needs at least two points");
  const y: number[] = [];
  for (let i = 0; i < samples; i++) {
    const x = i / (samples - 1);
    const wave = amplitude * Math.sin(2 * Math.PI * (waves * x + phase));
    const nearWall = Math.exp(-x / meniscusWidth) + Math.exp(-(1 - x) / meniscusWidth);
    y.push(wave - meniscus * nearWall);
  }
  const mean = trapezoidMean(y);
  return y.map((v) => v - mean);
}

/** How the surface settles after the levels change: a damped oscillation from 1 at t = 0 to rest at t = 1. */
export function settle(t: number): number {
  if (t >= 1) return 0;
  return Math.exp(-4 * t) * Math.cos(3 * Math.PI * t) * (1 - t);
}

export interface Point { x: number; y: number }

export interface JarFrame {
  width: number;
  side: number;
  top: number;
  bottom: number;
  radius: number;
  stroke: number;
  incomeLevel: number;
  expenseLevel: number;
  incomeSurface: Point[];
  expenseSurface: Point[];
  /** Spending has risen past the income: the two liquids mix. */
  mixed: boolean;
}

const SAMPLES = 96;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Everything's position for one frame; t is 0..1 of the settling, ms the time since it began. */
export function jarFrame(width: number, height: number, income: number, expense: number, t: number, ms: number): JarFrame {
  const side = 12;
  const top = 6;
  const bottom = height - 6;
  const inside = Math.max(bottom - top, 1);
  // The levels rise with an ease-out; the surface sloshes and comes to rest.
  const rise = 1 - (1 - t) * (1 - t) * (1 - t);
  const slosh = settle(t);
  const amplitude = (3 + 12 * Math.abs(slosh)) / inside;
  const meniscus = (6 * rise) / inside;
  const phase = ms / 170;
  const incomeLevel = top + inside * clamp01(income) * rise + 8 * slosh;
  const expenseLevel = bottom - inside * clamp01(expense) * rise - 8 * slosh;
  const usable = width - 2 * side;
  // Income hangs from the lid, so its meniscus pulls down at the walls; spending climbs them.
  const incomeWave = surface(SAMPLES, amplitude, phase + 0.3, 1.4, -meniscus);
  const expenseWave = surface(SAMPLES, amplitude * 0.85, -phase + 1.9, 1.1, meniscus);
  const x = (i: number) => side + (usable * i) / (SAMPLES - 1);
  return {
    width, side, top, bottom, radius: 28, stroke: 1.5, incomeLevel, expenseLevel,
    incomeSurface: incomeWave.map((w, i) => ({ x: x(i), y: incomeLevel + w * inside })),
    expenseSurface: expenseWave.map((w, i) => ({ x: x(i), y: expenseLevel + w * inside })),
    mixed: expenseLevel < incomeLevel,
  };
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const line = (ps: Point[]) => ps.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ");

/** The SVG paths of a frame: the income from the lid down, the spending from the floor up, the mixed band, the two surfaces. */
export function jarPaths(j: JarFrame): { income: string; expense: string; band: string | null; incomeLine: string; expenseLine: string } {
  const right = j.width - j.side;
  const income = `M${f(j.side)} ${f(j.top)} L${f(right)} ${f(j.top)} ${[...j.incomeSurface].reverse().map((p) => `L${f(p.x)} ${f(p.y)}`).join(" ")} Z`;
  const expense = `M${f(j.side)} ${f(j.bottom)} ${j.expenseSurface.map((p) => `L${f(p.x)} ${f(p.y)}`).join(" ")} L${f(right)} ${f(j.bottom)} Z`;
  const band = j.mixed ? `${line(j.incomeSurface)} ${[...j.expenseSurface].reverse().map((p) => `L${f(p.x)} ${f(p.y)}`).join(" ")} Z` : null;
  return { income, expense, band, incomeLine: line(j.incomeSurface), expenseLine: line(j.expenseSurface) };
}

/** Where the figure sits: in the gap between the liquids, or near the lid, over the income, once they mix. */
export function figureTop(j: JarFrame, deficit: boolean): number {
  return Math.max(0, deficit || j.mixed ? j.top + 16 : (j.incomeLevel + j.expenseLevel) / 2 - 30);
}

export interface Bubble { x: number; y: number; r: number; light: boolean }

/** The mixed band's bubbles: seeded, so the same deficit always looks the same. */
export function emulsion(seed = 11, count = 64): Bubble[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => ({ x: next(), y: next(), r: 2 + next() * 5, light: i % 2 === 0 }));
}
