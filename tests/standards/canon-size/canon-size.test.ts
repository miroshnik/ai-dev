import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Файл ядра и его бюджет в байтах: то, что грузится в каждую сессию и каждого субагента. */
interface Core {
  file: string;
  limit: number;
}
const CORE: Core[] = [
  { file: "AGENTS.md", limit: 32 * 1024 },
  { file: "claude/CLAUDE.md", limit: 5 * 1024 },
];

/** Размер как его увидит контекст: байты UTF-8 целиком, блоки кода не исключаются. */
export const sizeOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** Куда ядро отправляет читателя: скилл `name` (``the `name` skill`` или ``skill `name` ``) или справочник `docs/<name>.md`. */
interface Pointer {
  kind: "skill" | "doc";
  name: string;
}
export function pointers(md: string): Pointer[] {
  const out = new Map<string, Pointer>();
  for (const m of md.matchAll(/`([a-z][\w-]*)`\s+skills?\b|\bskills?\s+`([a-z][\w-]*)`/g)) {
    const name = (m[1] ?? m[2])!;
    out.set(`skill:${name}`, { kind: "skill", name });
  }
  for (const m of md.matchAll(/`docs\/([\w-]+\.md)`/g)) out.set(`doc:${m[1]}`, { kind: "doc", name: m[1]! });
  return [...out.values()];
}
const pointerPath = (p: Pointer) => (p.kind === "skill" ? `skills/${p.name}/SKILL.md` : `docs/${p.name}`);

describe("Ядро канона умещается в бюджет контекста", () => {
  invariant(it, {
    registry: "файлы ядра канона с бюджетом",
    items: CORE,
    key: (c) => c.file,
    name: (c) => `${c.file} не больше ${c.limit / 1024} КиБ`,
    check: (c) => {
      const size = sizeOf(read(c.file));
      if (size > c.limit) throw new Error(`${c.file}: ${size} байт при бюджете ${c.limit} — вынести справочное в скилл или docs/ (tests/standards/canon-size)`);
    },
    violator: { name: "файл на байт больше бюджета", item: { file: "AGENTS.md", limit: sizeOf(read("AGENTS.md")) - 1 } },
    includes: ["AGENTS.md", "claude/CLAUDE.md"],
  });

  it("указатель на скилл — `the `name` skill` или `skill `name``; команда скилла в бэктиках указателем не считается", () => {
    const md = "The `github` skill creates tasks; skill `est` estimates; `github project fix` turns it off; `docs/testing.md`.";
    expect(pointers(md)).toEqual([
      { kind: "skill", name: "github" },
      { kind: "skill", name: "est" },
      { kind: "doc", name: "testing.md" },
    ]);
  });

  it("бюджет считается по байтам файла в UTF-8, блоки кода не исключаются", () => {
    const md = "# Правило\n\n```bash\nnpx -y github:miroshnik/ai-dev install\n```\n";
    expect(sizeOf(md)).toBe(Buffer.from(md, "utf8").length);
    expect(sizeOf("ё")).toBe(2);
  });

  invariant(it, {
    registry: "скиллы и справочники docs/, на которые ядро отправляет читателя",
    rule: "существуют",
    items: pointers(read("AGENTS.md")),
    key: (p) => pointerPath(p),
    name: (p) => `${pointerPath(p)} есть в репозитории`,
    check: (p) => {
      if (!existsSync(path.join(ROOT, pointerPath(p)))) throw new Error(`ядро ссылается на ${pointerPath(p)}, а его нет — вынесенное потерялось (tests/standards/canon-size)`);
    },
    violator: { name: "ссылка ядра на удалённый скилл", item: { kind: "skill" as const, name: "billing" } },
    includes: ["skills/est/SKILL.md", "skills/github/SKILL.md", "skills/spec/SKILL.md", "docs/ci-concurrency.md", "docs/parallel-checkouts.md"],
  });
});
