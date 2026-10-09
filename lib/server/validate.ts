// Checks on a request's JSON body. A bad field is a 400, and nothing is changed.

import { HttpError } from "./http-error";

export type Body = Record<string, unknown>;

function bad(message: string): HttpError {
  return new HttpError(400, "bad_input", message);
}

export function asBody(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("Send a JSON object.");
  return raw as Body;
}

export function text(body: Body, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw bad(`${key} must be text of 1 to ${max} characters.`);
  return value.trim();
}

export function optionalText(body: Body, key: string, max = 500): string | null {
  if (body[key] === undefined || body[key] === null || body[key] === "") return null;
  return text(body, key, max);
}

export function isoDate(body: Body, key: string): string {
  const value = text(body, key, 10);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw bad(`${key} must be a date like 2026-04-02.`);
  }
  return value;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw bad(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function wholeNumber(body: Body, key: string, min: number, max: number): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function yesNo(body: Body, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw bad(`${key} must be true or false.`);
  return value;
}
