import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { documentsOf, FRAGMENT_FILES, readFragmentFile, type YamlDocument } from "../../lib/yaml-fragments.ts";

/** Шаг `actions/upload-artifact`: место, имя артефакта, пути и `include-hidden-files`; `error` — документ не разобран. */
interface Upload {
  file: string;
  line: number;
  name: string;
  paths: string[];
  hidden: unknown;
  error?: string;
  key: string;
}

const UPLOAD = /\buses\s*:\s*["']?actions\/upload-artifact@/;

/** Шаги загрузки в дереве YAML — в порядке документа. */
function stepsIn(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => stepsIn(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.uses === "string" && o.uses.startsWith("actions/upload-artifact@")) out.push(o);
    Object.values(o).forEach((v) => stepsIn(v, out));
  }
  return out;
}

/**
 * Загрузки документа. Строка шага — по порядку строк `uses: actions/upload-artifact@`. Документ с загрузкой, который
 * не разбирается, — элемент с ошибкой: иначе его шаги выпали бы из реестра молча.
 */
function uploadsIn(doc: YamlDocument): Omit<Upload, "key">[] {
  const lines = doc.text.split("\n");
  const at = lines.flatMap((l, i) => (UPLOAD.test(l) ? [doc.offset + i + 1] : []));
  let tree: unknown;
  try {
    tree = Bun.YAML.parse(doc.text);
  } catch (e) {
    if (!at.length) return [];
    return [{ file: doc.file, line: at[0]!, name: "фрагмент YAML", paths: [], hidden: undefined, error: (e as Error).message }];
  }
  return stepsIn(tree).map((step, i) => {
    const w = (step.with ?? {}) as Record<string, unknown>;
    const paths = typeof w.path === "string" ? w.path.split("\n").map((p) => p.trim()).filter(Boolean) : [];
    return { file: doc.file, line: at[i] ?? doc.offset + 1, name: String(w.name ?? "artifact"), paths, hidden: w["include-hidden-files"] };
  });
}

/** Загрузки файла с ключами: файл и имя артефакта; одинаковые в одном файле — с номером по порядку. */
function uploadsOf(file: string, text: string): Upload[] {
  const seen = new Map<string, number>();
  return documentsOf(file, text)
    .flatMap(uploadsIn)
    .map((u) => {
      const base = u.error ? `${u.file}:${u.line} ${u.name}` : `${u.file} artifact «${u.name}»`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { ...u, key: n > 1 ? `${base} (${n})` : base };
    });
}

/**
 * Скрытый ли путь: часть, начинающаяся с точки, — файл или каталог (`.spec-*.json`, `out/.cache/`). `.` и `..` — не
 * скрытые, исключение `!…` ничего не загружает.
 */
const hiddenPath = (p: string): boolean => !p.startsWith("!") && p.split("/").some((s) => s.startsWith(".") && s !== "." && s !== "..");

/** Нарушение шага — `файл:строка` и почему; пусто — скрытые файлы дойдут до артефакта. */
function violation(u: Upload): string | null {
  if (u.error) return `${u.file}:${u.line} — фрагмент YAML с upload-artifact не разбирается: ${u.error}`;
  const hidden = u.paths.filter(hiddenPath);
  if (!hidden.length || u.hidden === true) return null;
  return (
    `${u.file}:${u.line} — артефакт «${u.name}»: путь «${hidden.join("», «")}» скрытый, а include-hidden-files: true нет — ` +
    "upload-artifact пропустит скрытые файлы, артефакт выйдет пустым"
  );
}

const check = (u: Upload): void => {
  const v = violation(u);
  if (v) throw new Error(v);
};

const one = (file: string, text: string): Upload => {
  const [u, ...rest] = uploadsOf(file, text);
  if (!u || rest.length) throw new Error(`${file}: ждали одну загрузку, нашли ${rest.length + (u ? 1 : 0)}`);
  return u;
};

const UPLOADS = FRAGMENT_FILES.flatMap((f) => uploadsOf(f, readFragmentFile(f)));

describe("Каждая загрузка артефакта со скрытым путём — с include-hidden-files: true", () => {
  invariant(it, {
    registry: "шаги actions/upload-artifact в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md",
    items: UPLOADS,
    key: (u) => u.key,
    name: (u) => `${u.key} не теряет скрытые файлы`,
    check,
    violator: {
      name: "отчёты .spec-*.json без include-hidden-files",
      item: one("ci.yml", "jobs:\n  spec:\n    steps:\n      - uses: actions/upload-artifact@v7\n        with: { name: spec-reports, path: \".spec-*.json\" }\n"),
    },
    // шаг, ушедший от разбора (другой вид фрагмента, флоу-запись), выпал бы из реестра молча
    includes: [
      ".github/workflows/ci.yml artifact «docs-spec»",
      "skills/spec/ci.md artifact «spec-journal-unit-${{ matrix.shard }}»",
      "skills/spec/ci.md artifact «spec-reports»",
    ],
  });

  describe("примеры", () => {
    it("скрытый путь без include-hidden-files — ошибка с файлом и строкой", () => {
      const md = "# CI\n\n```yaml\n- if: github.event_name == 'pull_request'\n  uses: actions/upload-artifact@v7\n  with: { name: spec-reports, path: \".spec-*.json\" }\n```\n";
      expect(violation(one("docs/x.md", md))).toBe(
        "docs/x.md:5 — артефакт «spec-reports»: путь «.spec-*.json» скрытый, а include-hidden-files: true нет — " +
          "upload-artifact пропустит скрытые файлы, артефакт выйдет пустым",
      );
      const on = "- uses: actions/upload-artifact@v7\n  with: { name: j, path: .spec-journal/, include-hidden-files: true }\n";
      expect(violation(one("a.yml", on))).toBeNull();
    });

    it("скрытый каталог в середине пути и строка списка путей — тоже скрытые; ./ и исключение ! — нет", () => {
      const list = "- uses: actions/upload-artifact@v7\n  with:\n    name: out\n    path: |\n      dist/\n      out/.cache/report.json\n";
      expect(violation(one("a.yml", list))).toContain("путь «out/.cache/report.json» скрытый");
      const plain = "- uses: actions/upload-artifact@v7\n  with:\n    name: out\n    path: |\n      ./dist/\n      ../out/*.json\n      !dist/.map\n";
      expect(violation(one("b.yml", plain))).toBeNull();
    });

    it("путь без скрытых частей не требует include-hidden-files", () => {
      expect(violation(one("a.yml", "- uses: actions/upload-artifact@v7\n  with: { name: docs-spec, path: docs/spec/ }\n"))).toBeNull();
    });

    it("фрагмент с upload-artifact, который не разбирается, — ошибка, а не пропуск", () => {
      const broken = "```yaml\n- uses: actions/upload-artifact@v7\n  with: { name: x, path: .x\n```\n";
      expect(violation(one("docs/x.md", broken))).toStartWith("docs/x.md:2 — фрагмент YAML с upload-artifact не разбирается: ");
      expect(uploadsOf("docs/y.md", "```yaml\nconcurrency: { group: x\n```\n")).toEqual([]);
    });
  });
});
