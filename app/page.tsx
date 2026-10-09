// Home page: the engine preview.
// The cases are evaluated here, on the server, by the same pure functions the full build uses.
// Prompts 5 to 7 in specs/10-build-plan.md replace this page with the signed-in screens.

import PreviewApp from "@/components/preview/PreviewApp";
import { DEMO_START_DAY } from "@/lib/demo/cases";
import { prepareDemoCases } from "@/lib/demo/prepare";

export default function Home() {
  const cases = prepareDemoCases();
  return <PreviewApp cases={cases} startDay={DEMO_START_DAY} />;
}
