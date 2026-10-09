// Date helpers. All dates are ISO strings ("2026-04-02") handled in UTC, so results do not depend on the server's time zone.
// The engine never reads the real clock. Callers pass sim_clock.today.

export type ISODate = string;

const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(d: ISODate): [number, number, number] {
  const [y, m, day] = d.split("-").map(Number);
  return [y, m, day];
}

function toUTC(d: ISODate): number {
  const [y, m, day] = parts(d);
  return Date.UTC(y, m - 1, day);
}

function fromUTC(t: number): ISODate {
  return new Date(t).toISOString().slice(0, 10);
}

export function makeDate(year: number, month: number, day: number): ISODate {
  return fromUTC(Date.UTC(year, month - 1, day));
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUTC(toUTC(d) + n * MS_PER_DAY);
}

/** Whole days from a to b. Positive when b is later. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / MS_PER_DAY);
}

export function dayOfMonth(d: ISODate): number {
  return parts(d)[2];
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function daysInMonthOf(d: ISODate): number {
  const [y, m] = parts(d);
  return daysInMonth(y, m);
}

export function monthKey(d: ISODate): string {
  return d.slice(0, 7);
}

/** Moves a date by whole months, clamping the day to the target month's length. */
export function addMonths(d: ISODate, n: number): ISODate {
  const [y, m, day] = parts(d);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/** First day of the month that is n months after the month of d. */
export function monthStart(d: ISODate, n = 0): ISODate {
  const [y, m] = parts(d);
  const index = y * 12 + (m - 1) + n;
  return makeDate(Math.floor(index / 12), (index % 12) + 1, 1);
}

/** "3 May", "8 April" */
export function formatDate(d: ISODate): string {
  const [, m, day] = parts(d);
  return `${day} ${MONTHS_LONG[m - 1]}`;
}

/** "3 May", "8 Apr". For tight table cells. */
export function formatDateShort(d: ISODate): string {
  const [, m, day] = parts(d);
  return `${day} ${MONTHS[m - 1]}`;
}

/** "3 May" from a day offset after a due date. */
export function formatDay(dueDate: ISODate, day: number): string {
  return formatDate(addDays(dueDate, day));
}

export function monthName(d: ISODate): string {
  return MONTHS_LONG[parts(d)[1] - 1];
}

/** "Rs 12,000" from paise, with Indian digit grouping. Paise show only when the amount is not whole rupees. */
export function formatRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  const digits = String(rupees);
  let grouped = digits;
  if (digits.length > 3) {
    const last3 = digits.slice(-3);
    const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${head},${last3}`;
  }
  const decimals = rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`;
  return `${negative ? "-" : ""}Rs ${grouped}${decimals}`;
}
