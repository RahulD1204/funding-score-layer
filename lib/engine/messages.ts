// Message and reason text.
// Templates carry every fact. Claude may polish the wording of a customer message,
// and the checks here reject any rewrite that changes a fact or hints at income.
// In the app these templates live in the prompts table; this file is the seed and the test fixture.

import { formatDate, formatRupees, type ISODate } from "./dates";

export const TEMPLATE_VERSION = "t1";

export const TEMPLATES = {
  lending_retry:
    "Your EMI of {amount} to {merchant} didn't go through on {dueDate}. We'll try again on {plannedDate}.",
  insurance_retry:
    "Your premium of {amount} to {merchant} didn't go through on {dueDate}. We'll try again on {plannedDate}. Your cover continues until {graceEnd}.",
  payment_link: "You can pay your {kind} of {amount} to {merchant} here: {link}",
  merchant_reason: "Suggested from payment timing. Advice only.",
  ops_reason: "Payment pattern around {anchor}, based on {observations} observations, confidence {confidence}%.",
} as const;
export type TemplateName = keyof typeof TEMPLATES;

/** Words that hint at income. They must never appear in customer or merchant text. */
export const BANNED_WORDS = ["salary", "payday", "pay day", "income", "employer", "wage", "wages", "balance", "paycheck"];

export function fillTemplate(name: TemplateName, values: Record<string, string>): string {
  return TEMPLATES[name].replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Template ${name} is missing a value for {${key}}`);
    return values[key];
  });
}

export function findBannedWords(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => new RegExp(`\\b${w.replace(" ", "\\s+")}\\b`).test(lower));
}

export interface RetryMessageInput {
  segment: "lending" | "insurance";
  merchantName: string;
  amountPaise: number;
  dueDate: ISODate;
  plannedDate: ISODate;
  graceEnd?: ISODate;
}

export interface BuiltMessage {
  text: string;
  /** The exact strings a rewrite must keep. */
  facts: { amount: string; dates: string[]; merchant: string };
}

export function buildRetryMessage(input: RetryMessageInput): BuiltMessage {
  const amount = formatRupees(input.amountPaise);
  const dueDate = formatDate(input.dueDate);
  const plannedDate = formatDate(input.plannedDate);
  if (input.segment === "insurance") {
    if (!input.graceEnd) throw new Error("An insurance message needs the grace-period end date");
    const graceEnd = formatDate(input.graceEnd);
    return {
      text: fillTemplate("insurance_retry", { amount, merchant: input.merchantName, dueDate, plannedDate, graceEnd }),
      facts: { amount, dates: [dueDate, plannedDate, graceEnd], merchant: input.merchantName },
    };
  }
  return {
    text: fillTemplate("lending_retry", { amount, merchant: input.merchantName, dueDate, plannedDate }),
    facts: { amount, dates: [dueDate, plannedDate], merchant: input.merchantName },
  };
}

const AMOUNT_PATTERN = /(?:Rs\.?|₹|INR)\s?[\d,]+(?:\.\d+)?/gi;
const DATE_PATTERN = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/gi;

function normaliseAmount(s: string): string {
  return s.replace(/(?:Rs\.?|₹|INR)\s?/i, "").replace(/,/g, "").replace(/\.0+$/, "");
}

function normaliseDate(s: string): string {
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})/);
  return m ? `${Number(m[1])} ${m[2].toLowerCase()}` : s.toLowerCase();
}

export interface PolishCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Decides whether a model's rewrite may replace the template text.
 * It must keep the amount, every date and the merchant name, add no other amount or date,
 * and contain no banned word. Otherwise the template is kept.
 */
export function validatePolish(rewrite: string, facts: BuiltMessage["facts"]): PolishCheck {
  const problems: string[] = [];
  if (!rewrite.trim()) problems.push("empty rewrite");

  const allowedAmount = normaliseAmount(facts.amount);
  const amounts = (rewrite.match(AMOUNT_PATTERN) ?? []).map(normaliseAmount);
  if (!amounts.includes(allowedAmount)) problems.push("amount missing");
  for (const a of amounts) if (a !== allowedAmount) problems.push(`unexpected amount ${a}`);

  const allowedDates = facts.dates.map(normaliseDate);
  const dates = (rewrite.match(DATE_PATTERN) ?? []).map(normaliseDate);
  for (const d of allowedDates) if (!dates.includes(d)) problems.push(`date missing: ${d}`);
  for (const d of dates) if (!allowedDates.includes(d)) problems.push(`unexpected date ${d}`);

  if (!rewrite.includes(facts.merchant)) problems.push("merchant name missing");

  for (const w of findBannedWords(rewrite)) problems.push(`banned word: ${w}`);

  // Longer rewrites are where invented details creep in.
  if (rewrite.length > 400) problems.push("rewrite too long");

  return { ok: problems.length === 0, problems };
}
