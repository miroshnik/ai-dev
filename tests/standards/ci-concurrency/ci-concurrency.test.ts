import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { documentsOf, FRAGMENT_FILES, indentOf, readFragmentFile } from "../../lib/yaml-fragments.ts";

/** Блок `concurrency` workflow или job: место, путь YAML, группа и `queue`, события `on:` его документа (null — `on:` нет). */
interface Found {
  file: string;
  line: number;
  where: string;
  group: string;
  queue: unknown;
  events: string[] | null;
}

/** Блок реестра — с ключом: файл, путь YAML и группа. */
type Block = Found & { key: string };

const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
// фрагмент без `on:` идёт под любым событием — проверяем и PR, и push
const ANY_EVENT = ["pull_request", "push"];

const skippable = (l: string): boolean => !l.trim() || l.trimStart().startsWith("#");

/** Ключ со строки `i` и строки под ним глубже отступом — YAML одного ключа, отступ снят. */
function keyChunk(lines: string[], i: number): unknown {
  const indent = indentOf(lines[i]!);
  let end = i + 1;
  while (end < lines.length && (skippable(lines[end]!) || indentOf(lines[end]!) > indent)) end++;
  const text = lines
    .slice(i, end)
    .map((l) => (indentOf(l) >= indent ? l.slice(indent) : ""))
    .join("\n");
  const parsed = Bun.YAML.parse(text) as Record<string, unknown> | null;
  return parsed ? Object.values(parsed)[0] : null;
}

/** События `on:` документа: строка, список или ключи карты; `on:` нет — null. */
function eventsOf(lines: string[]): string[] | null {
  const i = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (i < 0) return null;
  const on = keyChunk(lines, i);
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === "object" ? Object.keys(on) : [];
}

/** Ключи над строкой `i` по отступам — путь YAML; внутри блочного скаляра (`run: |`) — null: это текст, не ключ. */
function parentsOf(lines: string[], i: number): string[] | null {
  const out: string[] = [];
  let threshold = indentOf(lines[i]!);
  for (let j = i - 1; j >= 0 && threshold > 0; j--) {
    const l = lines[j]!;
    if (skippable(l) || indentOf(l) >= threshold) continue;
    const m = /^\s*(?:-\s+)?["']?([^"'\s:#]+)["']?\s*:(.*)$/.exec(l);
    if (!m) return null;
    if (/^\s*[|>][-+]?\d*\s*(?:#.*)?$/.test(m[2]!)) return null;
    out.unshift(m[1]!);
    threshold = indentOf(l);
  }
  return out;
}

/** Блоки `concurrency` документа YAML; `offset` — строк в файле до документа (фрагмент в Markdown). */
function blocksIn(file: string, text: string, offset = 0): Found[] {
  const lines = text.split("\n");
  const events = eventsOf(lines);
  const out: Found[] = [];
  lines.forEach((l, i) => {
    if (!/^\s*concurrency\s*:/.test(l)) return;
    const parents = parentsOf(lines, i);
    if (!parents) return;
    const value = keyChunk(lines, i);
    const spec = typeof value === "string" ? { group: value } : ((value ?? {}) as { group?: unknown; queue?: unknown });
    out.push({ file, line: offset + i + 1, where: [...parents, "concurrency"].join("."), group: String(spec.group ?? ""), queue: spec.queue, events });
  });
  return out;
}

/** Ключ блока: файл, путь YAML и группа; одинаковые в одном файле — с номером по порядку. */
function withKeys(blocks: Found[]): Block[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const base = `${b.file} ${b.where} «${b.group}»`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...b, key: n > 1 ? `${base} (${n})` : base };
  });
}

/** Блоки файла от корня проекта по тексту. */
const blocksOf = (file: string, text: string): Block[] => withKeys(documentsOf(file, text).flatMap((d) => blocksIn(file, d.text, d.offset)));

const BLOCKS = FRAGMENT_FILES.flatMap((f) => blocksOf(f, readFragmentFile(f)));

/**
 * Своя ли группа у PR или прогона на событии. Выражение `a || b` берёт первое непустое: номер PR вне PR пуст — значит,
 * работает запасное. Группа своя, если своё хоть одно её выражение `${{ … }}`; литерал — общий.
 */
function ownOn(group: string, event: string): boolean {
  return [...group.matchAll(/\$\{\{(.*?)\}\}/g)].some(([, expr]) => {
    for (const alt of expr!.split("||").map((t) => t.trim())) {
      if (alt === "github.run_id") return true;
      if (/^github\.(event\.(pull_request\.)?number|head_ref)$/.test(alt)) {
        if (PR_EVENTS.has(event)) return true;
        continue; // вне PR пусто — берётся следующее
      }
      // github.ref у pull_request — refs/pull/<N>/merge, у pull_request_target — ветка базы
      return alt === "github.ref" && event === "pull_request";
    }
    return false;
  });
}

/** Нарушение блока — `файл:строка` и почему; пусто — блок не вытесняет ожидающий прогон. */
function violation(b: Block): string | null {
  if (b.queue === "max") return null;
  const events = b.events?.length ? b.events : ANY_EVENT;
  const shared = events.filter((e) => !ownOn(b.group, e));
  if (!shared.length) return null;
  const on = b.events?.length ? shared.join(", ") : `${shared.join(", ")} — on: не задан`;
  return `${b.file}:${b.line} — группа «${b.group}» общая (${on}) и без queue: max: ожидающий прогон вытеснит следующий`;
}

const check = (b: Block): void => {
  const v = violation(b);
  if (v) throw new Error(v);
};

const one = (file: string, text: string): Block => {
  const [b, ...rest] = blocksOf(file, text);
  if (!b || rest.length) throw new Error(`${file}: ждали один блок concurrency, нашли ${rest.length + (b ? 1 : 0)}`);
  return b;
};

const ONE_WORKFLOW =
  "вариант «CI и деплой в одном workflow» docs/ci-concurrency.md: queue: max несовместим с cancel-in-progress прогонов PR, а своя группа у прогона " +
  "пустила бы деплои main параллельно; вытеснение ожидающего прогона — записанная цена варианта, там же сказано, что CI и деплой разносят";

describe("Каждый блок concurrency с общей группой — queue: max", () => {
  invariant(it, {
    registry: "блоки concurrency в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md",
    items: BLOCKS,
    key: (b) => b.key,
    name: (b) => `${b.key} не вытесняет ожидающий прогон`,
    check,
    violator: [
      {
        name: "прогон main в группе по PR с запасным github.ref",
        item: one(
          "ci.yml",
          "on:\n  pull_request:\n  push:\n    branches: [main]\nconcurrency:\n  group: ci-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
        ),
      },
      {
        name: "job с общей группой без queue: max",
        item: one("ci.yml", "on: push\njobs:\n  publish:\n    concurrency: { group: spec-publish, cancel-in-progress: false }\n"),
      },
    ],
    // блок, ушедший от разбора (другой отступ, другой вид фрагмента), выпал бы из реестра молча
    includes: [
      ".github/workflows/ci.yml jobs.spec-publish.concurrency «spec-publish»",
      "docs/ci-concurrency.md concurrency «cd-${{ github.ref }}»",
      "docs/ci-concurrency.md jobs.deploy-dev.concurrency «deploy-dev»",
      "skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish»",
    ],
    outside: [{ item: "docs/ci-concurrency.md concurrency «${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}»", reason: ONE_WORKFLOW }],
  });

  describe("примеры", () => {
    it("общая группа без queue: max — ошибка с файлом и строкой", () => {
      expect(violation(one("deploy.yml", "on: push\n\nconcurrency:\n  group: deploy\n"))).toBe(
        "deploy.yml:3 — группа «deploy» общая (push) и без queue: max: ожидающий прогон вытеснит следующий",
      );
      const md = "# CI\n\nТекст.\n\n```yaml\non: push\njobs:\n  deploy:\n    concurrency: deploy-prod\n```\n";
      expect(violation(one("docs/x.md", md))).toStartWith("docs/x.md:9 — группа «deploy-prod» общая (push)");
    });

    it("общая группа с queue: max — блоком и строкой job — не вытесняет", () => {
      expect(violation(one("cd.yml", "on: push\nconcurrency:\n  group: cd-${{ github.ref }}\n  queue: max\n"))).toBeNull();
      expect(violation(one("cd.yml", "on: push\njobs:\n  deploy:\n    concurrency: { group: deploy-dev, queue: max } # окружение\n"))).toBeNull();
    });

    it("группа по PR с запасным github.ref в workflow только на pull_request — своя", () => {
      expect(violation(one("ci.yml", "on:\n  pull_request:\nconcurrency:\n  group: ci-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true\n"))).toBeNull();
    });

    it("запасное run_id — своя группа у прогона main", () => {
      expect(violation(one("ci.yml", "on: [pull_request, push]\nconcurrency:\n  group: ci-${{ github.event.pull_request.number || github.run_id }}\n"))).toBeNull();
    });

    it("github.ref своя только у pull_request: у pull_request_target это ветка базы", () => {
      expect(violation(one("a.yml", "on: pull_request\nconcurrency: ${{ github.workflow }}-${{ github.ref }}\n"))).toBeNull();
      expect(violation(one("b.yml", "on: pull_request_target\nconcurrency: ${{ github.workflow }}-${{ github.ref }}\n"))).toContain("общая (pull_request_target)");
    });

    it("фрагмент без on: идёт под любым событием — группа по PR без запасного run_id общая", () => {
      const b = one("docs/x.md", "```yml\nconcurrency:\n  group: ${{ github.event.pull_request.number || github.ref }}\n```\n");
      expect(violation(b)).toBe(
        "docs/x.md:2 — группа «${{ github.event.pull_request.number || github.ref }}» общая (push — on: не задан) и без queue: max: ожидающий прогон вытеснит следующий",
      );
    });

    it("concurrency в тексте скрипта и в прозе — не блок", () => {
      const yml = "on: push\njobs:\n  x:\n    steps:\n      - run: |\n          concurrency: shared\n";
      expect(blocksOf("x.yml", yml)).toEqual([]);
      expect(blocksOf("docs/x.md", "Группа `concurrency:` — по PR.\n\n```ts\nconcurrency: 1\n```\n")).toEqual([]);
    });

    it("одинаковые блоки одного файла различает номер", () => {
      const job = "```yaml\njobs:\n  publish:\n    concurrency: { group: publish, queue: max }\n```\n";
      expect(blocksOf("docs/x.md", job + "\n" + job).map((b) => b.key)).toEqual([
        "docs/x.md jobs.publish.concurrency «publish»",
        "docs/x.md jobs.publish.concurrency «publish» (2)",
      ]);
    });
  });
});
