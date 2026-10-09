// The engine preview: fixed demo cases played through the real engine, with no login and no database.
// It was the home page until build step 7; the home page is now the login.

import PreviewApp from "@/components/preview/PreviewApp";
import { DEMO_START_DAY } from "@/lib/demo/cases";
import { prepareDemoCases } from "@/lib/demo/prepare";

export default function PreviewPage() {
  const cases = prepareDemoCases();
  return <PreviewApp cases={cases} startDay={DEMO_START_DAY} />;
}
