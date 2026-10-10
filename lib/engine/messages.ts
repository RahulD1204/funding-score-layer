// Message and reason text.
// Templates carry every fact. Claude may polish the wording of a customer message,
// and the checks here reject any rewrite that changes a fact or hints at income.
// The templates stay in code, so every fact comes from code; each stored message carries
// TEMPLATE_VERSION. The polish instructions live in the prompts table (lib/server/agents/prompts.ts).

import { formatDate, formatRupees, type ISODate } from "./dates";
import type { SimCase } from "./simulate";

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

/**
 * Words that hint at income. They must never appear in customer or merchant text.
 * Each word also catches its plural and spelling variants (salaries, paydays, pay-day, paycheque).
 */
const BANNED_PATTERNS: Record<string, RegExp> = {
  salary: /\bsalar(?:y|ies|ied)\b/,
  payday: /\bpay-?days?\b/,
  "pay day": /\bpay\s+days?\b/,
  income: /\bincomes?\b/,
  employer: /\bemployers?\b/,
  wage: /\bwage\b/,
  wages: /\bwages\b/,
  balance: /\bbalances?\b/,
  paycheck: /\bpay\s*-?\s*(?:checks?|cheques?)\b/,
  earnings: /\bearnings?\b/,
};
export const BANNED_WORDS = Object.keys(BANNED_PATTERNS);

/** Words that name what a merchant or customer must never see: a score, confidence, tier, or the funded day. */
const INTERNAL_PATTERNS: Record<string, RegExp> = {
  score: /\bscor(?:e|es|ed|ing)\b/,
  confidence: /\bconfiden(?:ce|t)\b/,
  tier: /\btiers?\b/,
  probability: /\bprobabilit(?:y|ies)\b/,
  funded: /\bfund(?:ed|ing)\b/,
  percent: /%|\bper\s*cent\b|\bpercentage\b/,
};

/** Longest one-line reason a merchant may be shown. */
export const MAX_REASON_LENGTH = 200;

export function fillTemplate(name: TemplateName, values: Record<string, string>): string {
  return TEMPLATES[name].replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Template ${name} is missing a value for {${key}}`);
    return values[key];
  });
}

export function findBannedWords(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => BANNED_PATTERNS[w].test(lower));
}

/** Words for a score, confidence, tier, a percentage or the funded day. */
export function findInternalWords(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.keys(INTERNAL_PATTERNS).filter((w) => INTERNAL_PATTERNS[w].test(lower));
}

/**
 * Checks model-written text a merchant will read, such as the desk agent's one-line reason.
 * Empty when the text may be shown as written; otherwise the problems, and the caller uses its own text.
 */
export function checkReasonText(text: string): string[] {
  const problems: string[] = [];
  if (!text.trim()) problems.push("empty reason");
  if (/[\r\n]/.test(text)) problems.push("more than one line");
  if (text.length > MAX_REASON_LENGTH) problems.push("reason too long");
  for (const w of findBannedWords(text)) problems.push(`banned word: ${w}`);
  for (const w of findInternalWords(text)) problems.push(`internal word: ${w}`);
  return problems;
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

export interface LinkMessageInput {
  kind: "EMI" | "premium";
  merchantName: string;
  amountPaise: number;
  link: string;
}

/** The payment-link text. It is never polished: validatePolish does not check the link itself. */
export function buildLinkMessage(input: LinkMessageInput): BuiltMessage {
  const amount = formatRupees(input.amountPaise);
  return {
    text: fillTemplate("payment_link", { kind: input.kind, amount, merchant: input.merchantName, link: input.link }),
    facts: { amount, dates: [], merchant: input.merchantName },
  };
}

/** A customer message the case now needs: a retry notice for a debit, or the text of a sent link. */
export type MessageDue = { type: "retry"; actionId: number; day: number } | { type: "link"; actionId: number };

/**
 * The customer messages a change to a case calls for (specs/06 section 7, "Lock"). Compares the
 * case before and after: a debit that locked, or a locked debit held to a new date, needs a retry
 * notice for its date; a link that was sent needs the link text. `before` is null for a new case.
 */
export function messagesDue(before: SimCase | null, after: SimCase): MessageDue[] {
  const prior = new Map((before?.actions ?? []).map((a) => [a.id, a]));
  const due: MessageDue[] = [];
  for (const a of after.actions) {
    const was = prior.get(a.id);
    if (a.kind === "link") {
      if (a.status === "sent" && was?.status !== "sent") due.push({ type: "link", actionId: a.id });
      continue;
    }
    // Planned: not locked yet. Cancelled or dropped: it will not run, so there is nothing to announce.
    if (a.status === "planned" || a.status === "cancelled" || a.status === "dropped") continue;
    const announced = was !== undefined && was.status !== "planned" && was.day === a.day;
    if (!announced) due.push({ type: "retry", actionId: a.id, day: a.day });
  }
  return due;
}

const AMOUNT_PATTERN = /(?:Rs\.?|₹|INR)\s?[\d,]+(?:\.\d+)?/gi;
const DATE_PATTERN = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/gi;

function normaliseAmount(s: string): string {
  return s.replace(/(?:Rs\.?|₹|INR)\s?/i, "").replace(/,/g, "").replace(/\.0+$/, "");
}

const MONTH_WORD = /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/g;
const DAY_WORD = /\b(?:today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * Once the amount, the dates and the name are taken out, no number, month or day word may be
 * left: a date written another way ("April 12", "12/04", "the 7th", "tomorrow") or a
 * percentage is rejected. So is a word for a score, confidence, tier or the funded day.
 * "May" is left to the number check, because it is also an ordinary word.
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

  // What is left once the checked facts are taken out may carry no other number, month or day.
  const rest = rewrite
    .replace(new RegExp(escapeRegExp(facts.merchant), "g"), " ")
    .replace(AMOUNT_PATTERN, " ")
    .replace(DATE_PATTERN, " ")
    .toLowerCase();
  for (const n of rest.match(/\d+(?:[,./:-]\d+)*/g) ?? []) problems.push(`unexpected number ${n}`);
  for (const w of rest.match(MONTH_WORD) ?? []) problems.push(`unexpected date word ${w}`);
  for (const w of rest.match(DAY_WORD) ?? []) problems.push(`unexpected date word ${w}`);

  for (const w of findBannedWords(rewrite)) problems.push(`banned word: ${w}`);
  for (const w of findInternalWords(rewrite)) problems.push(`internal word: ${w}`);

  // Longer rewrites are where invented details creep in.
  if (rewrite.length > 400) problems.push("rewrite too long");

  return { ok: problems.length === 0, problems };
}
