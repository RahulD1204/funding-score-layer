// The signed case link for the customer phone mock (specs/03: "the customer mock routes, which
// take a signed case token"). The customer has no login; the link itself proves which case it is.
//
// A token is the case id and an HMAC-SHA256 signature over it, keyed with CUSTOMER_LINK_SECRET.
// Nobody can make a valid link for another case without the secret. Server code only.
// The version tag lets the format change later without old links being misread.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

function secret(): string {
  const value = process.env.CUSTOMER_LINK_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("CUSTOMER_LINK_SECRET is not set on the server.");
  return value;
}

function sign(caseId: string): Buffer {
  return createHmac("sha256", secret()).update(`${VERSION}:${caseId}`).digest();
}

export function customerToken(caseId: string): string {
  return `${VERSION}.${Buffer.from(caseId).toString("base64url")}.${sign(caseId).toString("base64url")}`;
}

/** The case id a token was signed for, or null for anything forged, altered or malformed. */
export function caseIdFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const caseId = Buffer.from(parts[1], "base64url").toString();
  if (!caseId || caseId.length > 200) return null;
  const given = Buffer.from(parts[2], "base64url");
  const expected = sign(caseId);
  return given.length === expected.length && timingSafeEqual(given, expected) ? caseId : null;
}
