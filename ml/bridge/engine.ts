// Runs the real rule engine for the offline pipeline, so Python never re-implements a schedule or flow rule.
// Reads a JSON request from the file named in argv[2] and writes the answer to argv[3].
//
//   node --import ./ml/bridge/register.mjs ml/bridge/engine.ts in.json out.json
//
// Tasks:
//   estimate  estimateFunding on each input (the parity check against ml/fsl/rule.py)
//   simulate  schedules + the case clock against a true funded day, and Razorpay's original retries
//   triage    triageByRules on each failure (how many catch-all codes rules and lookups resolve)

import { readFileSync, writeFileSync } from "node:fs";
import {
  advanceTo,
  buildSchedules,
  estimateFunding,
  openCase,
  outcomeOf,
  simulateBaseline,
  triageByRules,
  type EstimateInput,
  type MandateStatus,
  type MerchantType,
  type Segment,
} from "../../lib/engine";

interface SimulateItem {
  segment: Segment;
  merchantType: MerchantType;
  /** False when the case fails open: only Razorpay's original retries run. */
  layerActs: boolean;
  h: number;
  u: number;
  likelihoodByDay: number[];
  salaryRecognized: boolean;
  lastAllowedDay: number;
  maxRepresentations: number;
  resultDelayDays: number;
  baselineRetryDays: number[];
  fundedOnDay: number | null;
}

interface TriageItem {
  errorReason: string;
  mandateStatus: MandateStatus;
  downtimeActive: boolean;
}

type Request =
  | { task: "estimate"; items: EstimateInput[] }
  | { task: "simulate"; items: SimulateItem[] }
  | { task: "triage"; items: TriageItem[] };

function simulate(item: SimulateItem) {
  const original = simulateBaseline(item.baselineRetryDays, item.resultDelayDays, item.fundedOnDay);
  if (!item.layerActs) return { layer: null, original };
  const build = buildSchedules({
    h: item.h,
    u: item.u,
    likelihoodByDay: item.likelihoodByDay,
    segment: item.segment,
    lastAllowedDay: item.lastAllowedDay,
    maxRepresentations: item.maxRepresentations,
    resultDelayDays: item.resultDelayDays,
    salaryRecognized: item.salaryRecognized,
  });
  const opened = openCase({
    merchantType: item.merchantType,
    build,
    standingDefault: "Balanced",
    resultDelayDays: item.resultDelayDays,
    lastAllowedDay: item.lastAllowedDay,
  });
  const done = advanceTo(opened, 30, { fundedOnDay: item.fundedOnDay });
  return { layer: { route: build.route, ...outcomeOf(done) }, original };
}

const request = JSON.parse(readFileSync(process.argv[2], "utf8")) as Request;
let result: unknown[];
switch (request.task) {
  case "estimate":
    result = request.items.map((input) => {
      const e = estimateFunding(input);
      return {
        ok: e.ok,
        failReason: e.failReason ?? null,
        source: e.source,
        salaryRecognized: e.salaryRecognized,
        h: e.h,
        u: e.u,
        likelihoodByDay: e.likelihoodByDay,
        confidence: e.confidence,
        confidenceBeforeDeductions: e.confidenceBeforeDeductions,
        anchor: e.anchor,
        driftApplied: e.driftApplied,
      };
    });
    break;
  case "simulate":
    result = request.items.map(simulate);
    break;
  case "triage":
    result = request.items.map((item) => triageByRules(item));
    break;
}
writeFileSync(process.argv[3], JSON.stringify(result));
