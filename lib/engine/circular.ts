// Circular statistics for days of the month.
// A plain average breaks at month-end: the days 29, 30, 31, 1 and 2 average to 18.6.
// On a circle, day 31 and day 1 are neighbours, so the same days have a median of 31.

import { POLICY } from "./policy";
import { addMonths, daysInMonth, daysInMonthOf, dayOfMonth, makeDate, type ISODate } from "./dates";

export function circularDistance(a: number, b: number, period: number = POLICY.circle): number {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The value in the list with the smallest total circular distance to all the others.
 * Ties go to the smaller value, so the result is deterministic.
 */
export function circularMedian(values: number[], period: number = POLICY.circle): number {
  if (values.length === 0) throw new Error("circularMedian of an empty list");
  const candidates = [...new Set(values)].sort((x, y) => x - y);
  let best = candidates[0];
  let bestTotal = Infinity;
  for (const c of candidates) {
    let total = 0;
    for (const v of values) total += circularDistance(c, v, period);
    if (total < bestTotal) {
      best = c;
      bestTotal = total;
    }
  }
  return best;
}

/** Median absolute deviation around a centre, measured on the circle. */
export function circularMad(values: number[], centre: number, period: number = POLICY.circle): number {
  return median(values.map((v) => circularDistance(v, centre, period)));
}

/**
 * A funded day can be anchored to the start of the month ("the 7th")
 * or to its end ("one day before the last day"), which fits last-working-day salaries.
 */
export type AnchorKind = "start" | "end";
export interface Anchor {
  kind: AnchorKind;
  /** start: day of month, 1 to 31. end: days before the month's last day, 0 to 30. */
  value: number;
}

export function positionOf(date: ISODate, kind: AnchorKind): number {
  return kind === "start" ? dayOfMonth(date) : daysInMonthOf(date) - dayOfMonth(date);
}

export interface AnchorFit {
  anchor: Anchor;
  mad: number;
  positions: number[];
}

export function fitAnchor(dates: ISODate[], kind: AnchorKind): AnchorFit {
  const positions = dates.map((d) => positionOf(d, kind));
  const value = circularMedian(positions);
  return { anchor: { kind, value }, mad: circularMad(positions, value), positions };
}

function totalDistance(fit: AnchorFit): number {
  let total = 0;
  for (const p of fit.positions) total += circularDistance(p, fit.anchor.value);
  return total;
}

/**
 * Fits both anchors and keeps the one whose dates sit closer to its median, measured as the
 * total distance. A tie keeps the start anchor. The total is used instead of the MAD because
 * the MAD ignores a single stray month: February alone can make a wrong anchor look perfect.
 */
export function bestAnchor(dates: ISODate[]): AnchorFit {
  const start = fitAnchor(dates, "start");
  const end = fitAnchor(dates, "end");
  return totalDistance(end) < totalDistance(start) ? end : start;
}

function occurrenceInMonth(kind: AnchorKind, value: number, year: number, month: number): ISODate {
  const dim = daysInMonth(year, month);
  const day = kind === "start" ? Math.min(value, dim) : Math.max(1, dim - value);
  return makeDate(year, month, day);
}

/**
 * The first date on or after `onOrAfter` that matches the anchor position.
 * A day that does not exist in a month (the 31st in April) falls on that month's last day.
 */
export function nextOccurrence(kind: AnchorKind, value: number, onOrAfter: ISODate): ISODate {
  const [y, m] = onOrAfter.split("-").map(Number);
  const inMonth = occurrenceInMonth(kind, value, y, m);
  if (inMonth >= onOrAfter) return inMonth;
  const next = addMonths(makeDate(y, m, 1), 1);
  const [ny, nm] = next.split("-").map(Number);
  return occurrenceInMonth(kind, value, ny, nm);
}
