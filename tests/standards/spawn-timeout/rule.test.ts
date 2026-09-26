/**
 * Тест, который запускает процессы (git, node, bun), держит таймаут `SPAWN_TIMEOUT`, а не 5 с bun по умолчанию, — чтобы
 * нагрузка машины не роняла зелёные тесты.
 *
 * Время такого теста — время его процессов, а оно растёт с нагрузкой: параллельные сессии агентов замедляют запуск node
 * и git в разы, и тест на секунду идёт 5–15 с, а установка через npm — до 45 с. Падение по таймауту тогда ложное —
 * гонки и ожидания событий нет, тест детерминирован; таймаут 2 мин ловит только зависание.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

// Таймаут — в каждом файле, а не один на прогон: ключа timeout у bun test в bunfig.toml нет (документация bun),
// setDefaultTimeout в preload действует только на первый файл прогона (проверено на bun 1.4.2), а --timeout в скриптах
// package.json не видит голый `bun test`. 2 мин — запас ×2,5 к установке через npm под нагрузкой ~70 на 16 ядрах
// (44–48 с; при обычной нагрузке — 4,5 с).

const TESTS = fileURLToPath(new URL("../../", import.meta.url));

interface File {
  path: string;
  text: string;
}

// импорт значений (не `import type`) с начала строки: пример кода в строке теста — не импорт
const importsFrom = (text: string, source: RegExp) =>
  [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].some((m) => source.test(m[1]!));
const CHILD_PROCESS = /^node:child_process$/;

/** Модули tests/lib, которые запускают процессы: сами или через другой такой модуль. */
function spawningLib(lib: File[]): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of lib) {
      if (out.has(path.basename(f.path))) continue;
      const viaLib = [...out].some((name) => importsFrom(f.text, new RegExp(`(^|/)${name.replace(".", "\\.")}$`)));
      if (importsFrom(f.text, CHILD_PROCESS) || viaLib) out.add(path.basename(f.path)), (grew = true);
    }
  }
  return out;
}

/** Файлы тестов, которые запускают процессы: `node:child_process` или хелпер из такого модуля tests/lib. */
function spawning(tests: File[], lib: File[]): File[] {
  const libs = [...spawningLib(lib)];
  return tests.filter((f) => importsFrom(f.text, CHILD_PROCESS) || libs.some((name) => importsFrom(f.text, new RegExp(`/lib/${name.replace(".", "\\.")}$`))));
}

/** Нарушения правила: файл запускает процессы, а таймаут на уровне файла не задан. */
function violations(tests: File[], lib: File[]): string[] {
  return spawning(tests, lib)
    .filter((f) => !/^setDefaultTimeout\(SPAWN_TIMEOUT\);$/m.test(f.text))
    .map((f) => `${f.path}: запускает процессы без setDefaultTimeout(SPAWN_TIMEOUT)`);
}

function read(dir: string, match: (name: string) => boolean): File[] {
  return readdirSync(path.join(TESTS, dir), { recursive: true, encoding: "utf8" })
    .filter((rel) => match(rel))
    .map((rel) => ({ path: path.join("tests", dir, rel), text: readFileSync(path.join(TESTS, dir, rel), "utf8") }));
}

describe("Тест, который запускает процессы, не падает от нагрузки машины: таймаут SPAWN_TIMEOUT", () => {
  it("тесты ai-dev, которые запускают процессы, задают setDefaultTimeout(SPAWN_TIMEOUT)", () => {
    const tests = [...read("capabilities", (n) => n.endsWith(".test.ts")), ...read("standards", (n) => n.endsWith(".test.ts"))];
    const lib = read("lib", (n) => n.endsWith(".ts"));
    // правило не пустое: под него попадают установщик, скрипты spec и est
    expect(spawning(tests, lib).map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "tests/capabilities/install/install.test.ts",
        "tests/capabilities/update/update.test.ts",
        "tests/capabilities/spec-diff/spec-diff.test.ts",
        "tests/capabilities/spec-doc/spec-doc.test.ts",
        "tests/capabilities/est/est.test.ts",
        "tests/standards/node-runtime/rule.test.ts",
      ]),
    );
    expect(violations(tests, lib)).toEqual([]);
  });

  describe("примеры", () => {
    const guard = 'import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";\nsetDefaultTimeout(SPAWN_TIMEOUT);\n';
    const lib = [
      { path: "tests/lib/git.ts", text: 'import { execFileSync } from "node:child_process";\nexport function gitRepo() {}\n' },
      { path: "tests/lib/pkg.ts", text: 'import { gitRepo } from "./git.ts";\nexport function pkg() {}\n' },
      { path: "tests/lib/fake.ts", text: "export const fake = {};\n" },
    ];

    it("файл с node:child_process без таймаута — нарушение", () => {
      const text = 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["status"]);\n';
      expect(violations([{ path: "a.test.ts", text }], lib)).toEqual(["a.test.ts: запускает процессы без setDefaultTimeout(SPAWN_TIMEOUT)"]);
    });

    it("хелпер из модуля tests/lib, который запускает процессы сам или через другой модуль, — тоже нарушение", () => {
      expect(violations([{ path: "a.test.ts", text: 'import { gitRepo } from "../../lib/git.ts";\n' }], lib)).toHaveLength(1);
      expect(violations([{ path: "b.test.ts", text: 'import { pkg } from "../../lib/pkg.ts";\n' }], lib)).toHaveLength(1);
    });

    it("с setDefaultTimeout(SPAWN_TIMEOUT) — чисто", () => {
      expect(violations([{ path: "a.test.ts", text: `import { gitRepo } from "../../lib/git.ts";\n${guard}` }], lib)).toEqual([]);
    });

    it("без процессов — вне правила: свой модуль без процессов, import type, пример кода в строке", () => {
      const text = [
        'import { fake } from "../../lib/fake.ts";',
        'import type { Run } from "../../lib/git.ts";',
        "const example = 'import { spawnSync } from \"node:child_process\";';",
      ].join("\n");
      expect(violations([{ path: "a.test.ts", text }], lib)).toEqual([]);
    });
  });
});
