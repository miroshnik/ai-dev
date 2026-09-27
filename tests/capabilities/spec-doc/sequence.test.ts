import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { runScript, tmpDir, vitestReport, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

const MAIN = "tests/capabilities/billing/billing.test.ts";
const DESCRIBED = "tests/capabilities/billing/billing.md";
const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");

// метаданные прогона, как их пишет sequence харнесса: трасса сценария под его тестом
function traced(files: Record<string, string> = {}) {
  const sequence = [
    { from: "app", to: "db", message: "резерв" },
    { from: "app", to: "stripe", message: "списание" },
    { from: "send-email", to: "resend", message: "письмо" },
  ];
  writeTree(dir, {
    ".spec-meta/1.jsonl": JSON.stringify({ file: MAIN, test: "заказ оплачивается", id: "payment", sequence }) + "\n",
    [DESCRIBED]: "Счета.\n",
    ...files,
  });
  writeFileSync(path.join(dir, "r.json"), vitestReport(dir, { [MAIN]: [[["Оплата"], "заказ оплачивается"]] }));
}
const doc = (...args: string[]) => runScript("spec-doc", ["r.json", "--root", dir, ...args], dir);

const DIAGRAM = [
  "sequenceDiagram",
  "  participant app",
  "  participant db",
  "  participant stripe",
  "  participant send_email as send-email",
  "  participant resend",
  "  app->>db: резерв",
  "  app->>stripe: списание",
  "  send_email->>resend: письмо",
];

/** Схема на странице capability показывает, как части системы говорят в сценарии, — по трассе последнего прогона. */
describe("Сиквенс-схема сценария — на странице capability", () => {
  it("схема из трассы — под тестом сценария", () => {
    traced();
    expect(doc("--strict").code).toBe(0);
    expect(read("docs/spec/capabilities/billing.md")).toContain(["- ✅ заказ оплачивается", "  ```mermaid", ...DIAGRAM.map((l) => "  " + l), "  ```"].join("\n"));
  });

  it("метка `<!-- spec: sequence-<id> -->` в `<папка>.md` ставит схему туда, под тестом её тогда нет", () => {
    traced({ [DESCRIBED]: "Счета.\n\n<!-- spec: sequence-payment -->\n" });
    expect(doc("--strict").code).toBe(0);
    const page = read("docs/spec/capabilities/billing.md");
    expect(page).toContain(["Счета.", "", "```mermaid", ...DIAGRAM, "```"].join("\n"));
    expect(page.split("sequenceDiagram").length).toBe(2);
    expect(page).not.toContain("<!-- spec:");
  });

  it("метка сценария, которого нет, — spec-doc называет её, --strict — код 1", () => {
    traced({ [DESCRIBED]: "Счета.\n\n<!-- spec: sequence-refund -->\n" });
    const r = doc("--strict");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`spec-doc: метка <!-- spec: sequence-refund --> в ${DESCRIBED}: нет сценария refund в тестах папки`);
    expect(doc().code).toBe(0);
  });
});
