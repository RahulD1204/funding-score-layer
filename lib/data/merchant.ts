// What the lender and insurer screens read. Merchant-readable tables only (specs/04), with the
// user's own login, so row-level security returns the merchant's own rows and nothing else.
// An insurer's query for schedule_options returns no rows: the access rule is lenders only.

import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DeskItemRow, FixSettingRow, MerchantCaseRow, MerchantRow, ProductRow, ScheduleOptionRow } from "./rows";

function must<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

/** The simulated date (public.demo_today, migration 20261010000004). The sim_clock table stays ops-only. */
export async function demoToday(): Promise<string> {
  const supabase = await createClient();
  return must(await supabase.rpc("demo_today")) as string;
}

export async function listCases(): Promise<MerchantCaseRow[]> {
  const supabase = await createClient();
  return must(await supabase.from("merchant_cases").select("*").order("due_date").order("case_id")) as MerchantCaseRow[];
}

export interface MerchantCaseDetail {
  row: MerchantCaseRow;
  options: ScheduleOptionRow[];
  merchant: MerchantRow;
  product: ProductRow | null;
}

/** One case with its cards, its merchant and the product it belongs to. Null when not the viewer's. */
export async function getCase(caseId: string): Promise<MerchantCaseDetail | null> {
  const supabase = await createClient();
  const row = must(await supabase.from("merchant_cases").select("*").eq("case_id", caseId).maybeSingle()) as MerchantCaseRow | null;
  if (!row) return null;
  const [options, merchant, products] = await Promise.all([
    supabase.from("schedule_options").select("*").eq("case_id", caseId).order("main_day").then(must),
    supabase.from("merchants").select("*").eq("id", row.merchant_id).single().then(must),
    supabase.from("products").select("*").eq("merchant_id", row.merchant_id).then(must),
  ]);
  return {
    row,
    options: options as ScheduleOptionRow[],
    merchant: merchant as MerchantRow,
    product: productFor(row, products as ProductRow[]),
  };
}

/**
 * The product a case belongs to. merchant_cases carries the kind, not the product, and each demo
 * merchant has one product per segment. The case itself keeps the limits it opened with.
 */
export function productFor(row: Pick<MerchantCaseRow, "kind">, products: ProductRow[]): ProductRow | null {
  const segment = row.kind === "EMI" ? "lending" : "insurance";
  return products.find((p) => p.segment === segment) ?? null;
}

export interface MerchantSettings {
  merchant: MerchantRow;
  products: ProductRow[];
  fixes: FixSettingRow[];
}

export async function getSettings(merchantId: string): Promise<MerchantSettings> {
  const supabase = await createClient();
  const [merchant, products, fixes] = await Promise.all([
    supabase.from("merchants").select("*").eq("id", merchantId).single().then(must),
    supabase.from("products").select("*").eq("merchant_id", merchantId).order("id").then(must),
    supabase.from("fix_settings").select("fix_type, mode").eq("merchant_id", merchantId).then(must),
  ]);
  return { merchant: merchant as MerchantRow, products: products as ProductRow[], fixes: fixes as FixSettingRow[] };
}

export async function getMerchant(merchantId: string): Promise<MerchantRow> {
  const supabase = await createClient();
  return must(await supabase.from("merchants").select("*").eq("id", merchantId).single()) as MerchantRow;
}

export async function listProducts(): Promise<ProductRow[]> {
  const supabase = await createClient();
  return must(await supabase.from("products").select("*")) as ProductRow[];
}

/** The exceptions desk queue, soonest deadline first, with the case each item belongs to. */
export async function listDeskItems(): Promise<DeskItemRow[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("desk_items")
      .select("*, merchant_cases(customer_label, kind, amount_paise, due_date, failure_words, state)")
      .order("deadline", { ascending: true, nullsFirst: false })
      .order("created_at"),
  ) as DeskItemRow[];
  return rows;
}
