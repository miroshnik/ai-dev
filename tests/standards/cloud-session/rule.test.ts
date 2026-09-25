/**
 * Скрипты скиллов, которые ходят в GitHub Projects, в облачной сессии выходят с объяснением, а не сбоем `gh`.
 *
 * Облачной сессии Claude Code Projects v2 недоступны (403): скрипт без проверки падает непонятной ошибкой `gh`, и
 * агент ищет причину не там. Проверка — переменная `CLAUDE_CODE_REMOTE`, объяснение ведёт в `docs/cloud-sessions.md`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

// Projects v2 — GraphQL (projectV2, ProjectV2…) или `gh project …`
const PROJECTS = /projectV2|ProjectV2|\bgh project\b|\["project",/;

/** Нарушения правила: путь скрипта и чего в нём нет. Скрипт без Projects v2 — вне правила. */
function violations(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((x) => PROJECTS.test(x.text))) {
    if (!f.text.includes("CLAUDE_CODE_REMOTE")) out.push(`${f.path}: нет проверки CLAUDE_CODE_REMOTE`);
    else if (!f.text.includes("docs/cloud-sessions.md")) out.push(`${f.path}: объяснение без ссылки на docs/cloud-sessions.md`);
  }
  return out;
}

function skillScripts(): { path: string; text: string }[] {
  return readdirSync(SKILLS).flatMap((skill) => {
    const dir = path.join(SKILLS, skill, "scripts");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".ts"));
    } catch {
      return [];
    }
    return names.map((n) => ({ path: `skills/${skill}/scripts/${n}`, text: readFileSync(path.join(dir, n), "utf8") }));
  });
}

describe("Облачная сессия в скриптах с Projects v2", () => {
  it("скрипты скиллов ai-dev, которые ходят в Projects v2, проверяют облачную сессию и ссылаются на docs/cloud-sessions.md", () => {
    const scripts = skillScripts();
    // правило не пустое: под него попадают est и github
    expect(scripts.filter((f) => PROJECTS.test(f.text)).map((f) => f.path)).toEqual(expect.arrayContaining(["skills/est/scripts/est.ts", "skills/github/scripts/github.ts"]));
    expect(violations(scripts)).toEqual([]);
  });

  describe("примеры", () => {
    const query = 'const Q = `query { node(id: $id) { ... on ProjectV2 { title } } }`;';

    it("скрипт с Projects v2 без проверки CLAUDE_CODE_REMOTE — нарушение", () => {
      expect(violations([{ path: "x.ts", text: `${query}\nrun(Q);` }])).toEqual(["x.ts: нет проверки CLAUDE_CODE_REMOTE"]);
    });

    it("проверка есть, а объяснение не ведёт в docs/cloud-sessions.md — нарушение", () => {
      const text = `${query}\nif (process.env.CLAUDE_CODE_REMOTE === "true") throw new Error("облако");`;
      expect(violations([{ path: "x.ts", text }])).toEqual(["x.ts: объяснение без ссылки на docs/cloud-sessions.md"]);
    });

    it("проверка с объяснением — чисто; `gh project` — тоже Projects v2", () => {
      const guard = `if (process.env.CLAUDE_CODE_REMOTE === "true") throw new Error("облако: docs/cloud-sessions.md");`;
      expect(violations([{ path: "x.ts", text: `${query}\n${guard}` }])).toEqual([]);
      expect(violations([{ path: "y.ts", text: 'spawnSync("gh", ["project", "view"]);' }])).toEqual(["y.ts: нет проверки CLAUDE_CODE_REMOTE"]);
    });

    it("скрипт без Projects v2 — вне правила", () => {
      expect(violations([{ path: "x.ts", text: 'spawnSync("gh", ["pr", "view"]);' }])).toEqual([]);
    });
  });
});
