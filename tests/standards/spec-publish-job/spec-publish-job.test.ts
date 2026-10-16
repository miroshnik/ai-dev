import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { documentsOf, FRAGMENT_FILES, readFragmentFile, type YamlDocument } from "../../lib/yaml-fragments.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

/** Ответы копии на «check-run `<имя>` — публикация спеки?» — по имени, в том же порядке. */
type Recognize = (names: string[]) => boolean[];

/** Копия правила: скилл, файл и как она отвечает. */
interface Copy {
  skill: string;
  file: string;
  recognize: Recognize;
}

/** Строка `.sh` под `test()` jq — тем же движком, что `wait-ci.sh`: одна запись регулярки в JS и jq может значить разное. */
const viaJq =
  (pattern: string): Recognize =>
  (names) => {
    const r = spawnSync("jq", ["-nc", "--arg", "p", pattern, "--argjson", "names", JSON.stringify(names), "$names | map(test($p))"], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT,
    });
    if (r.status !== 0) throw new Error(`jq не разобрал правило «${pattern}»: ${exitOf(r)} ${r.stderr.trim()}`);
    return JSON.parse(r.stdout) as boolean[];
  };

const viaRegExp =
  (re: RegExp): Recognize =>
  (names) =>
    names.map((n) => re.test(n));

/** Копия `.sh` без строки в одинарных кавычках — ошибка на первом вопросе, а не пропуск в реестре. */
const unreadable =
  (file: string): Recognize =>
  () => {
    throw new Error(`${file}: SPEC_PUBLISH не строкой в одинарных кавычках — правило не прочитать`);
  };

/** Скрипты скиллов с `SPEC_PUBLISH`: `export const` в `.ts`, присваивание в `.sh` — новая копия попадает под таблицу сама. */
async function copies(): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => /\.(ts|sh)$/.test(f))
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = `skills/${skill}/scripts/${f}`;
      const text = readFileSync(path.join(dir, f), "utf8");
      if (f.endsWith(".ts") && /^export const SPEC_PUBLISH\b/m.test(text)) {
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        out.push({ skill, file, recognize: viaRegExp(mod.SPEC_PUBLISH) });
      } else if (f.endsWith(".sh") && /^SPEC_PUBLISH=/m.test(text)) {
        const m = /^SPEC_PUBLISH='([^']*)'$/m.exec(text);
        out.push({ skill, file, recognize: m ? viaJq(m[1]!) : unreadable(file) });
      }
    }
  }
  return out;
}

/** Таблица: имя check-run и ответ на «публикация спеки?». */
const TABLE: { name: string; publish: boolean; why: string }[] = [
  { name: "spec-publish", publish: true, why: "job публикации из фрагментов ci.md" },
  { name: "ci / spec-publish", publish: true, why: "тот же job в реюзабельном workflow" },
  { name: "ci / docs / spec-publish", publish: true, why: "вложенный реюзабельный workflow" },
  { name: "spec", publish: false, why: "сборка спеки — чек" },
  { name: "test:spec", publish: false, why: "стандарты и архитектура — чек" },
  { name: "test-spec", publish: false, why: "job стандартов — чек" },
  { name: "spec-publish-x", publish: false, why: "хвост за именем" },
  { name: "x-spec-publish", publish: false, why: "другое начало имени" },
  { name: "a / spec-publish / b", publish: false, why: "публикация — не последний сегмент" },
  { name: "spec-publish (1)", publish: false, why: "job с матрицей — GitHub дописывает её значения" },
];

const show = (publish: boolean) => (publish ? "публикация" : "чек");

/** Строки таблицы, на которые копия отвечает не по правилу. */
function mismatches(recognize: Recognize): string[] {
  const got = recognize(TABLE.map((row) => row.name));
  return TABLE.flatMap((row, i) => (got[i] === row.publish ? [] : [`${row.name}: ${show(got[i]!)}, а по правилу — ${show(row.publish)} (${row.why})`]));
}

// правило github без якорей: публикацией становится любое имя с spec-publish внутри
const unanchored: Copy = { skill: "github без якорей", file: "github.ts", recognize: viaRegExp(/spec-publish/) };
// строка ci-wait без реюзабельного workflow: «<job> / spec-publish» — чек, и FAIL ожидания после мержа возвращается
const bare: Copy = { skill: "ci-wait без «<job> / spec-publish»", file: "wait-ci.sh", recognize: viaJq("^spec-publish$") };

const registry = await copies();

describe("github и ci-wait одинаково узнают публикацию спеки по имени check-run: `spec-publish` и `<job> / spec-publish` — публикация, другое имя — чек", () => {
  invariant(it, {
    registry: "скрипты скиллов с правилом SPEC_PUBLISH",
    items: registry,
    key: (c) => c.skill,
    includes: ["ci-wait", "github"],
    name: (c) => `${c.skill} (${c.file}) узнаёт публикацию спеки по таблице`,
    check: (c) => {
      const wrong = mismatches(c.recognize);
      if (wrong.length) throw new Error(`${c.file}: SPEC_PUBLISH расходится с таблицей:\n${wrong.join("\n")}`);
    },
    violator: [
      { name: "копия правила в одном из скриптов расходится с таблицей", item: bare },
      { name: "правило без якорей узнаёт публикацией хвост и середину имени", item: unanchored },
    ],
  });

  it("таблица ловит расхождения копий без якорей и без реюзабельного workflow", () => {
    expect([...mismatches(unanchored.recognize), ...mismatches(bare.recognize)].map((m) => m.split(":")[0])).toEqual([
      "spec-publish-x",
      "x-spec-publish",
      "a / spec-publish / b",
      "spec-publish (1)",
      "ci / spec-publish",
      "ci / docs / spec-publish",
    ]);
  });
});

/** Job публикации: место, ключ job и имя его check-run; `error` — документ с публикацией не разобран. */
interface Job {
  file: string;
  line: number;
  id: string;
  checkRun: string;
  error?: string;
  key: string;
}

// шаг публикации: скрипт скилла, он же из пакета проекта (`elves spec-publish`, #559) или скрипт проекта, который его
// зовёт (CI Elves)
const PUBLISH_STEP = /spec-publish\.ts|\bspec:publish\b|\belves\b.*\sspec-publish\b/;

/** Имя check-run job: `name`, без него — ключ; с матрицей GitHub дописывает в скобках значения сочетания — здесь первого. */
function checkRunOf(id: string, job: Record<string, unknown>): string {
  const name = typeof job.name === "string" ? job.name : id;
  const matrix = (job.strategy as { matrix?: unknown } | undefined)?.matrix;
  if (!matrix) return name;
  const values =
    typeof matrix === "object"
      ? Object.entries(matrix as Record<string, unknown>)
          .filter(([k]) => k !== "include" && k !== "exclude")
          .map(([, v]) => String(Array.isArray(v) ? v[0] : v))
      : [String(matrix)];
  return `${name} (${values.join(", ")})`;
}

/** Job публикации документа: шаг `run` запускает публикацию. Документ с публикацией, который не разбирается, — элемент с ошибкой. */
function jobsIn(doc: YamlDocument): Omit<Job, "key">[] {
  const lines = doc.text.split("\n");
  const lineOf = (id: string) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s+["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`).test(l));
    return doc.offset + (i < 0 ? 0 : i) + 1;
  };
  let tree: unknown;
  try {
    tree = Bun.YAML.parse(doc.text);
  } catch (e) {
    const at = lines.findIndex((l) => PUBLISH_STEP.test(l));
    if (at < 0) return [];
    return [{ file: doc.file, line: doc.offset + at + 1, id: "фрагмент YAML", checkRun: "", error: (e as Error).message }];
  }
  const jobs = (tree as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object") return [];
  return Object.entries(jobs as Record<string, Record<string, unknown>>).flatMap(([id, job]) => {
    const steps = Array.isArray(job?.steps) ? (job.steps as Record<string, unknown>[]) : [];
    if (!steps.some((s) => typeof s?.run === "string" && PUBLISH_STEP.test(s.run))) return [];
    return [{ file: doc.file, line: lineOf(id), id, checkRun: checkRunOf(id, job) }];
  });
}

/** Job публикации файла с ключами: файл и путь job; одинаковые в одном файле — с номером по порядку. */
function jobsOf(file: string, text: string): Job[] {
  const seen = new Map<string, number>();
  return documentsOf(file, text)
    .flatMap(jobsIn)
    .map((j) => {
      const base = j.error ? `${j.file}:${j.line} ${j.id}` : `${j.file} jobs.${j.id}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { ...j, key: n > 1 ? `${base} (${n})` : base };
    });
}

/** Нарушение job — `файл:строка` и почему; пусто — каждая копия узнаёт его check-run публикацией. */
function violation(j: Job): string | null {
  if (j.error) return `${j.file}:${j.line} — фрагмент YAML с публикацией спеки не разбирается: ${j.error}`;
  const blind = registry.filter((c) => !c.recognize([j.checkRun])[0]).map((c) => c.skill);
  if (!blind.length) return null;
  return (
    `${j.file}:${j.line} — job ${j.id}: check-run «${j.checkRun}» не узнают публикацией спеки ${blind.join(" и ")} — ` +
    "её красный станет красным main, а ожидание после мержа — FAIL; назови job spec-publish"
  );
}

const one = (file: string, text: string): Job => {
  const [j, ...rest] = jobsOf(file, text);
  if (!j || rest.length) throw new Error(`${file}: ждали один job публикации, нашли ${rest.length + (j ? 1 : 0)}`);
  return j;
};

const JOBS = FRAGMENT_FILES.flatMap((f) => jobsOf(f, readFragmentFile(f)));

describe("job публикации во фрагментах CI скилла spec и в CI Elves назван так, что оба скрипта узнают его публикацией", () => {
  invariant(it, {
    registry: "job публикации спеки в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md",
    items: JOBS,
    key: (j) => j.key,
    // job, ушедший от разбора (другой шаг публикации, другой вид фрагмента), выпал бы из реестра молча
    includes: [".github/workflows/ci.yml jobs.spec-publish", "skills/spec/ci.md jobs.spec-publish", "skills/spec/ci.md jobs.spec-publish (2)"],
    name: (j) => `${j.key}: check-run «${j.checkRun}» — публикация для github и ci-wait`,
    check: (j) => {
      const v = violation(j);
      if (v) throw new Error(v);
    },
    violator: {
      name: "job публикации переименован во фрагменте",
      item: one("ci.yml", "jobs:\n  publish-docs:\n    steps:\n      - run: bun --no-env-file .agents/skills/spec/scripts/spec-publish.ts\n"),
    },
  });

  describe("примеры", () => {
    it("переименованный job — ошибка с файлом, строкой и копиями, которые его не узнают", () => {
      const md = "# CI\n\n```yaml\njobs:\n  publish-spec:\n    steps:\n      - run: pnpm spec:publish\n```\n";
      expect(violation(one("docs/x.md", md))).toBe(
        "docs/x.md:5 — job publish-spec: check-run «publish-spec» не узнают публикацией спеки ci-wait и github — " +
          "её красный станет красным main, а ожидание после мержа — FAIL; назови job spec-publish",
      );
    });

    it("имя check-run — name job, без него — ключ, с матрицей — с её значениями", () => {
      const job = (extra: string) => one("a.yml", `jobs:\n  spec-publish:\n${extra}    steps:\n      - run: bun spec-publish.ts\n`);
      expect(job("").checkRun).toBe("spec-publish");
      expect(job("    name: Publish spec\n").checkRun).toBe("Publish spec");
      expect(job("    strategy: { matrix: { node: [24] } }\n").checkRun).toBe("spec-publish (24)");
      expect(violation(job(""))).toBeNull();
      expect(violation(job("    strategy: { matrix: { node: [24] } }\n"))).toContain("check-run «spec-publish (24)»");
    });

    it("шаг со скриптом пакета — elves spec-publish из node_modules или пакет версии проекта через bunx — тоже публикация", () => {
      const job = (run: string) => one("a.yml", `jobs:\n  spec-publish:\n    steps:\n      - run: ${run}\n`);
      expect(job("bun --no-env-file node_modules/.bin/elves spec-publish").checkRun).toBe("spec-publish");
      expect(job(`bunx @miroshnik/elves@"$(jq -r '.devDependencies["@miroshnik/elves"]' package.json)" spec-publish`).checkRun).toBe("spec-publish");
      expect(jobsOf("a.yml", "jobs:\n  unit:\n    steps:\n      - run: bun --no-env-file node_modules/.bin/elves spec-run --artifact spec-reports\n")).toEqual([]);
    });

    it("публикация в тексте и job без шага публикации — не элементы; неразборный фрагмент с публикацией — ошибка", () => {
      expect(jobsOf("docs/x.md", "Job `spec-publish` запускает `spec-publish.ts`.\n\n```yaml\njobs:\n  spec:\n    steps:\n      - run: pnpm spec:doc\n```\n")).toEqual([]);
      const broken = "```yaml\njobs:\n  spec-publish: { steps: [ { run: bun spec-publish.ts }\n```\n";
      expect(violation(one("docs/y.md", broken))).toStartWith("docs/y.md:3 — фрагмент YAML с публикацией спеки не разбирается: ");
    });
  });
});
