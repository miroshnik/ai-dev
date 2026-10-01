import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Что ставит флоу и что README обязан назвать: ключ, название теста и признак упоминания. */
interface Part {
  key: string;
  name: string;
  mention: RegExp;
}

const skill = (name: string): Part => ({
  key: `skills/${name}`,
  name: `скилл ${name} — со ссылкой на skills/${name}/SKILL.md`,
  mention: new RegExp(`\\]\\(skills/${escape(name)}/SKILL\\.md\\)`),
});
// в README команда — строкой запуска: `npx -y github:miroshnik/ai-dev check -g` или `node …/bin/ai-dev.mjs release`
const command = (name: string): Part => ({
  key: `ai-dev ${name}`,
  name: `команда установщика ${name} названа`,
  mention: new RegExp(`ai-dev(?:\\.mjs)? ${escape(name)}\\b`),
});
const script = (skillName: string, name: string): Part => ({
  key: `skills/${skillName}/scripts/${name}`,
  name: `скрипт ${name} скилла ${skillName} назван`,
  mention: new RegExp(`\`${escape(name)}[\` .]`),
});
// подкоманда в README — в коде: отдельно (`est fact`) или перечнем через «|» (`github task new | status | drop`)
const subcommand = (scriptName: string, words: string[]): Part => ({
  key: `${scriptName} ${words.join(" ")}`,
  name: `подкоманда ${scriptName} ${words.join(" ")} названа`,
  mention: new RegExp(`\`${escape([scriptName, ...words.slice(0, -1)].join(" "))}(?: [a-z-]+ \\|)* ${escape(words[words.length - 1]!)}[\` ]`),
});
const reference = (file: string): Part => ({
  key: `docs/${file}`,
  name: `справочник docs/${file} — со ссылкой`,
  mention: new RegExp(`\\]\\(docs/${escape(file)}\\)`),
});

const usageOf = (source: string) => /const USAGE = `([\s\S]*?)`;/.exec(source)?.[1] ?? "";

/** Исполняемые скрипты скиллов — со строкой #!: библиотеки скилла (harness.ts, speclib.ts) README не перечисляет. */
function executables(): { skill: string; name: string; source: string }[] {
  const skills = readdirSync(path.join(ROOT, "skills")).filter((n) => existsSync(path.join(ROOT, "skills", n, "SKILL.md")));
  return skills.flatMap((s) => {
    const dir = path.join(ROOT, "skills", s, "scripts");
    const names = existsSync(dir) ? readdirSync(dir) : [];
    return names.map((n) => ({ skill: s, name: n.replace(/\.[^.]+$/, ""), source: read(`skills/${s}/scripts/${n}`) })).filter((x) => x.source.startsWith("#!"));
  });
}

/** Реестр из кода: скиллы, команды из справки установщика, исполняемые скрипты скиллов, справочники docs/. */
function parts(): Part[] {
  const skills = readdirSync(path.join(ROOT, "skills")).filter((n) => existsSync(path.join(ROOT, "skills", n, "SKILL.md")));
  const commands = [...new Set([...usageOf(read("bin/ai-dev.mjs")).matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1]!))];
  const scripts = executables().map((x) => script(x.skill, x.name));
  const references = readdirSync(path.join(ROOT, "docs")).filter((n) => n.endsWith(".md"));
  return [...skills.map(skill), ...commands.map(command), ...scripts, ...references.map(reference)];
}

/** Подкоманды из справки скрипта: слова после его имени до первого аргумента — `  github task close <N>` → `task close`. */
function subcommandsOf(scriptName: string, usage: string): Part[] {
  const lines = [...usage.matchAll(new RegExp(`^ {2}${escape(scriptName)}((?: [a-z][a-z-]*)+)`, "gm"))].map((m) => m[1]!.trim());
  return [...new Set(lines)].map((words) => subcommand(scriptName, words.split(" ")));
}

/** Реестр из кода: подкоманды из справки каждого исполняемого скрипта скилла; скрипт без подкоманд назван как скрипт. */
const subcommands = (): Part[] => executables().flatMap((x) => subcommandsOf(x.name, usageOf(x.source)));

/** Строки вне блоков кода: ссылка и заголовок в ``` — пример, а не разметка. */
function prose(md: string): string[] {
  let fenced = false;
  return md.split("\n").filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) return (fenced = !fenced), false;
    return !fenced;
  });
}

/** Якоря заголовков, как их строит GitHub: текст без разметки и пунктуации, пробел — дефис, повтор — `-1`, `-2`. */
function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of prose(md)) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!h) continue;
    const text = h.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Битые ссылки README: файл не существует или в нём нет раздела с таким якорем. Внешние ссылки — вне правила. */
function brokenLinks(md: string, file: (rel: string) => string | null): string[] {
  const links = prose(md).flatMap((line) => [...line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:href|src)="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!));
  const out: string[] = [];
  for (const link of links) {
    if (/^[a-z][a-z+.-]*:/i.test(link)) continue;
    const [target = "", hash] = link.split("#");
    const text = target ? file(target.replace(/\/$/, "")) : md;
    if (text === null) {
      out.push(`${link}: нет файла ${target}`);
      continue;
    }
    if (hash === undefined || !(target.endsWith(".md") || !target)) continue;
    const anchor = decodeURIComponent(hash);
    if (!anchors(text).has(anchor)) out.push(`${link}: нет раздела #${anchor} в ${target || "README.md"}`);
  }
  return out;
}

/** Файл или каталог репозитория: текст файла, "" для каталога, null — нет такого. */
function repoFile(rel: string): string | null {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

const README = read("README.md");

describe("README называет всё, что ставит флоу, и не ссылается на то, чего нет", () => {
  invariant(it, {
    registry: "скиллы, команды установщика и скиллов, справочники docs/",
    items: parts(),
    key: (p) => p.key,
    name: (p) => `README: ${p.name}`,
    check: (p) => {
      if (!p.mention.test(README)) throw new Error(`README не называет ${p.key} — допиши его в README (tests/standards/readme)`);
    },
    violator: { name: "скилл, которого README не называет", item: skill("billing") },
    includes: ["skills/spec", "ai-dev install", "ai-dev release", "skills/spec/scripts/spec-break", "skills/ci-wait/scripts/wait-ci", "docs/pr-checks.md"],
  });

  invariant(it, {
    registry: "подкоманды скриптов скиллов",
    items: subcommands(),
    key: (p) => p.key,
    name: (p) => `README: ${p.name}`,
    check: (p) => {
      if (!p.mention.test(README)) throw new Error(`README не называет подкоманду ${p.key} — допиши её в строку команд скилла в README (tests/standards/readme)`);
    },
    violator: { name: "подкоманда, которой README не называет", item: subcommand("github", ["task", "archive"]) },
    includes: ["github task close", "est cloud-import"],
  });

  it("относительные ссылки и якоря README ведут на существующие файлы и разделы", () => {
    expect(brokenLinks(README, repoFile)).toEqual([]);
  });

  describe("примеры", () => {
    const files: Record<string, string> = {
      "AGENTS.md": "# Правила\n\n## Тесты и код\n\n## Спецификация — решения\n\n## Git, PR и мерж\n",
      "skills/est/SKILL.md": "# est\n",
    };
    const file = (rel: string) => files[rel] ?? null;

    it("ссылка на удалённый скилл — нарушение", () => {
      expect(brokenLinks("Скилл [`openspec`](skills/openspec/SKILL.md).", file)).toEqual(["skills/openspec/SKILL.md: нет файла skills/openspec/SKILL.md"]);
    });

    it("якорь на переименованный раздел AGENTS.md — нарушение", () => {
      expect(brokenLinks("[спека](AGENTS.md#спецификация--тесты)", file)).toEqual(["AGENTS.md#спецификация--тесты: нет раздела #спецификация--тесты в AGENTS.md"]);
    });

    it("якоря — как у GitHub: тире и пунктуация выпадают, пробел — дефис, повтор — с номером", () => {
      expect(brokenLinks("[a](AGENTS.md#спецификация--решения) [b](AGENTS.md#git-pr-и-мерж) [c](skills/est/SKILL.md)", file)).toEqual([]);
      expect([...anchors("## Оценка и факт — скилл `est`\n## Итог\n## Итог\n```\n## не заголовок\n```\n")]).toEqual(["оценка-и-факт--скилл-est", "итог", "итог-1"]);
    });

    it("подкоманды — слова справки после имени скрипта до первого аргумента, без повторов", () => {
      const usage = "est — оценка\n\n  est fact <N> [--write]\n  est fact --sweep\n  est cloud-import <файл>...\n  dashboard [--repo o/r]\n";
      expect(subcommandsOf("est", usage).map((p) => p.key)).toEqual(["est fact", "est cloud-import"]);
      expect(subcommandsOf("dashboard", usage)).toEqual([]);
    });

    it("подкоманда названа отдельно или в перечне через «|»; перечень без неё и слово вне кода — нарушение", () => {
      const close = subcommand("github", ["task", "close"]).mention;
      expect(close.test("`github task close`")).toBe(true);
      expect(close.test("`github task new | status | drop | close` · `github pr labels`")).toBe(true);
      expect(close.test("`github task new | status | drop` · `github pr labels`")).toBe(false);
      expect(close.test("github task close закрывает задачу")).toBe(false);
    });

    it("внешняя ссылка и ссылка в блоке кода — вне правила", () => {
      expect(brokenLinks("[docs](https://agentskills.io/#x)\n```\n[нет](nowhere.md)\n```\n", file)).toEqual([]);
    });
  });
});
