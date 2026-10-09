// Settings (specs/02 screen 6). Lender and insurer, own merchant only. Reads merchants, products
// and fix_settings; every change goes through update-controls.

import { Suspense } from "react";
import ActionButton from "@/components/actions/ActionButton";
import { FixModeSelect, ProductLimitsForm } from "@/components/settings/SettingsForms";
import { PageLoading } from "@/components/shell/AppShell";
import { Chip, Fact, Panel } from "@/components/ui";
import { FIX_CATALOGUE, FIX_TYPES, formatDate, formatRupees } from "@/lib/engine";
import { getSettings } from "@/lib/data/merchant";
import { requireViewer } from "@/lib/data/session";

const RAIL_WORDS = { bank_mandate: "Bank mandate (eNACH), result in 2 days", upi_autopay: "UPI Autopay, instant result" } as const;

async function Settings() {
  const viewer = await requireViewer(["lender", "insurer"]);
  const { merchant, products, fixes } = await getSettings(viewer.merchantId!);
  const modeOf = (fix: string) => fixes.find((f) => f.fix_type === fix)?.mode ?? FIX_CATALOGUE[fix as keyof typeof FIX_CATALOGUE].startingMode;
  const lending = merchant.type === "lender";

  return (
    <div className="flex flex-col gap-4">
      {products.map((p) => (
        <Panel key={p.id} title={p.name} aside={<span className="text-xs text-muted">{RAIL_WORDS[p.rail]}</span>}>
          <ProductLimitsForm
            productId={p.id}
            lastAllowedDay={p.last_allowed_day}
            maxRepresentations={p.max_representations}
            standingDefault={p.standing_default}
            lending={lending}
          />
          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line pt-3 sm:grid-cols-3">
            {lending && (
              <Fact label="Disclosed penal charge per day">
                {p.penal_charge_per_day_paise === null ? "Not set" : formatRupees(p.penal_charge_per_day_paise)}
              </Fact>
            )}
            {lending && (
              <Fact label="Bounce charge per failed attempt">
                {p.bounce_charge_paise === null ? "Not set" : formatRupees(p.bounce_charge_paise)}
              </Fact>
            )}
            {!lending && p.grace_days !== null && <Fact label="Grace period">{p.grace_days} days after the due date</Fact>}
            <Fact label="Razorpay's original retry days">
              {p.baseline_retry_days.join(", ")} days after the due date
            </Fact>
          </dl>
          <p className="mt-2 text-xs text-muted">Charges come from your Key Facts Statement. They are shown here as you disclosed them.</p>
        </Panel>
      ))}

      <Panel title="Fixes on the exceptions desk">
        <p className="mb-3 text-sm text-muted">
          Automatic fixes run at once. A fix set to needs approval waits on the desk. Anything that contacts the customer
          starts as needs approval.
        </p>
        <ul className="flex flex-col divide-y divide-line">
          {FIX_TYPES.map((fix) => (
            <li key={fix} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 text-sm">
                {FIX_CATALOGUE[fix].description}
                {FIX_CATALOGUE[fix].contactsCustomer && <span className="ml-2 text-xs text-muted">Contacts the customer</span>}
              </span>
              <FixModeSelect fixType={fix} mode={modeOf(fix)} label={FIX_CATALOGUE[fix].description} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Layer controls">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Fact label="Consent">
            {merchant.consent_date ? `Recorded on ${formatDate(merchant.consent_date)} ${merchant.consent_date.slice(0, 4)}` : "Not recorded"}
          </Fact>
          <Fact label="Message polish">
            {merchant.polish_on ? "On" : "Off"}{" "}
            <span className="font-normal text-muted">(the switch arrives with message text, build step 9)</span>
          </Fact>
          <Fact label="Kill switch">
            {merchant.kill_switch ? <Chip tone="failed">On: Razorpay&apos;s original retries everywhere</Chip> : <Chip tone="paid">Off</Chip>}
          </Fact>
        </dl>
        <div className="mt-3">
          {merchant.kill_switch ? (
            <ActionButton route="update-controls" body={{ action: "set_kill_switch", on: false }} variant="secondary">
              Turn the kill switch off
            </ActionButton>
          ) : (
            <ActionButton
              route="update-controls"
              body={{ action: "set_kill_switch", on: true }}
              variant="danger"
              confirm="Turn the kill switch on? Every running plan stops and Razorpay's original retries resume."
            >
              Turn the kill switch on
            </ActionButton>
          )}
        </div>
      </Panel>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold text-navy">Settings</h1>
      <Suspense fallback={<PageLoading />}>
        <Settings />
      </Suspense>
    </>
  );
}
