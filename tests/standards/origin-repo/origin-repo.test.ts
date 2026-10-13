import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const SKILLS = fileURLToPath(new URL("../../../skills/", import.meta.url));

type Parse = (url: string) => string | null;
type Checkout = (origin: string, repo: string) => boolean;

/** Скрипты скиллов, которые экспортируют функцию `fn`: новая копия попадает под таблицу сама. */
async function exporters<F>(fn: string): Promise<{ skill: string; fn: F }[]> {
  const out: { skill: string; fn: F }[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!new RegExp(`^export function ${fn}\\(`, "m").test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ skill, fn: mod[fn] });
    }
  }
  return out;
}

/** Таблица правила: URL `origin` и ответ на «какой это репозиторий GitHub?» — `owner/repo` или `null`. */
const PARSE: { url: string; want: string | null; why: string }[] = [
  { url: "git@github.com:o/r.git", want: "o/r", why: "scp-вид SSH" },
  { url: "git@github.com:o/r", want: "o/r", why: "scp-вид без .git" },
  { url: "https://github.com/o/r", want: "o/r", why: "HTTPS" },
  { url: "https://github.com/o/r.git", want: "o/r", why: "HTTPS с .git" },
  { url: "https://github.com/o/r/", want: "o/r", why: "слеш на конце" },
  { url: "https://github.com/o/r.git/", want: "o/r", why: ".git и слеш на конце" },
  { url: "ssh://git@github.com/o/r.git", want: "o/r", why: "SSH со схемой" },
  { url: "ssh://git@github.com:22/o/r.git", want: "o/r", why: "порт в URL" },
  { url: "ssh://git@ssh.github.com:443/o/r.git", want: "o/r", why: "SSH через 443 — хост GitHub" },
  { url: "https://x-access-token:t0ken@github.com/o/r.git", want: "o/r", why: "учётные данные в URL" },
  { url: "https://GitHub.com/o/r", want: "o/r", why: "регистр хоста не важен" },
  { url: "https://github.com/Owner/Repo", want: "Owner/Repo", why: "регистр имени сохраняется" },
  { url: "git@github.com:o/o.github.io.git", want: "o/o.github.io", why: "точка в имени репозитория" },
  { url: "git@github.com:o/r.git\n", want: "o/r", why: "вывод git с переводом строки" },
  { url: "https://gitlab.com/o/r.git", want: null, why: "не GitHub" },
  { url: "https://notgithub.com/o/r", want: null, why: "хост — не подстрока" },
  { url: "https://github.com.evil.example/o/r", want: null, why: "github.com — начало чужого хоста" },
  { url: "/srv/mirror/github.com/o/r.git", want: null, why: "локальное зеркало" },
  { url: "/tmp/x/o/r.git", want: null, why: "локальный путь" },
  { url: "https://github.com/o", want: null, why: "без репозитория" },
  { url: "https://github.com/o/r/tree/main", want: null, why: "путь глубже корня репозитория" },
  { url: "", want: null, why: "нет origin" },
];

/** Таблица «чекаут репозитория X?»: URL `origin` чекаута, X и ответ. */
const CHECKOUT: { origin: string; repo: string; want: boolean; why: string }[] = [
  { origin: "git@github.com:miroshnik/ai-dev.git", repo: "miroshnik/ai-dev", want: true, why: "тот же репозиторий" },
  { origin: "https://github.com/miroshnik/ai-dev/", repo: "miroshnik/ai-dev", want: true, why: "другой вид URL" },
  { origin: "https://github.com/Miroshnik/AI-Dev", repo: "miroshnik/ai-dev", want: true, why: "GitHub регистр не различает" },
  { origin: "git@github.com:miroshnik/ai-dev.git", repo: "Miroshnik/AI-Dev", want: true, why: "регистр X не важен" },
  { origin: "git@github.com:miroshnik/ai-dev-tools.git", repo: "miroshnik/ai-dev", want: false, why: "тот же префикс имени" },
  { origin: "git@github.com:xmiroshnik/ai-dev.git", repo: "miroshnik/ai-dev", want: false, why: "тот же конец владельца" },
  { origin: "https://gitlab.com/miroshnik/ai-dev.git", repo: "miroshnik/ai-dev", want: false, why: "не GitHub" },
  { origin: "/tmp/x/miroshnik/ai-dev.git", repo: "miroshnik/ai-dev", want: false, why: "локальный путь" },
  { origin: "", repo: "miroshnik/ai-dev", want: false, why: "нет origin" },
];

const show = (v: string | null) => (v === null ? "не GitHub" : v);
const yes = (v: boolean) => (v ? "чекаут" : "не чекаут");

/** Строки таблицы разбора, на которые копия отвечает не по правилу. */
const parseMismatches = (parse: Parse) =>
  PARSE.filter((row) => parse(row.url) !== row.want).map((row) => `${JSON.stringify(row.url)}: ${show(parse(row.url))}, а по правилу — ${show(row.want)} (${row.why})`);

/** Строки таблицы чекаута, на которые копия отвечает не по правилу. */
const checkoutMismatches = (checkout: Checkout) =>
  CHECKOUT.filter((row) => checkout(row.origin, row.repo) !== row.want).map(
    (row) => `${JSON.stringify(row.origin)} при ${row.repo}: ${yes(checkout(row.origin, row.repo))}, а по правилу — ${yes(row.want)} (${row.why})`,
  );

// разбор до стандарта (#412) — одна копия во всех трёх скиллах: github.com — подстрока, регистр хоста важен, порт не понят
const before: Parse = (url) => {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
};
// проверка чекаута до стандарта (#412): X — подстрока URL origin
const substring: Checkout = (origin, repo) => origin.includes(repo);

const parsers = await exporters<Parse>("originRepo");
const checkouts = await exporters<Checkout>("checkoutOf");

describe("Репозиторий чекаута по origin определяется одинаково во всех скиллах", () => {
  invariant(it, {
    rule: "originRepo",
    registry: "скрипты скиллов с разбором origin",
    items: parsers,
    key: (c) => c.skill,
    includes: ["est", "github", "task-env"],
    name: (c) => `${c.skill} разбирает origin по таблице`,
    check: (c) => {
      const wrong = parseMismatches(c.fn);
      if (wrong.length) throw new Error(`${c.skill}: разбор origin расходится с правилом:\n${wrong.join("\n")}`);
    },
    violator: { name: "разбор до стандарта: github.com — подстрока, регистр хоста важен, порт не понят", item: { skill: "до #412", fn: before } },
  });

  invariant(it, {
    rule: "checkoutOf",
    registry: "скрипты скиллов с проверкой «чекаут репозитория X»",
    items: checkouts,
    key: (c) => c.skill,
    includes: ["github"],
    name: (c) => `${c.skill} узнаёт чекаут репозитория по равенству owner/repo без учёта регистра`,
    check: (c) => {
      const wrong = checkoutMismatches(c.fn);
      if (wrong.length) throw new Error(`${c.skill}: проверка чекаута расходится с правилом:\n${wrong.join("\n")}`);
    },
    violator: { name: "проверка чекаута подстрокой URL origin", item: { skill: "до #412", fn: substring } },
  });

  it("таблица ловит расхождения разбора до стандарта: подстрока хоста, регистр хоста, порт, зеркало", () => {
    expect(parseMismatches(before).map((m) => JSON.parse(m.slice(0, m.indexOf('":') + 1)))).toEqual([
      "ssh://git@github.com:22/o/r.git",
      "ssh://git@ssh.github.com:443/o/r.git",
      "https://GitHub.com/o/r",
      "https://notgithub.com/o/r",
      "/srv/mirror/github.com/o/r.git",
    ]);
  });

  it("таблица ловит проверку чекаута подстрокой: регистр, префикс имени, конец владельца, не GitHub", () => {
    expect(checkoutMismatches(substring).map((m) => JSON.parse(m.slice(0, m.indexOf('" при') + 1)))).toEqual([
      "https://github.com/Miroshnik/AI-Dev",
      "git@github.com:miroshnik/ai-dev.git",
      "git@github.com:miroshnik/ai-dev-tools.git",
      "git@github.com:xmiroshnik/ai-dev.git",
      "https://gitlab.com/miroshnik/ai-dev.git",
      "/tmp/x/miroshnik/ai-dev.git",
    ]);
  });
});
