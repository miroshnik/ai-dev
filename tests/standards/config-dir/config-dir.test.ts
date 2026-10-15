import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// правило — одно выражение: переменная, иначе каталог по умолчанию; `||`, а не `??` — пустая переменная тоже «иначе».
// Прежнее имя флоу (`ai-dev`, #545) — в нём же: переменная из профиля владельца и каталог машины, который `update -g`
// ещё не перенёс; на чистой машине — новый каталог
const HOME = String.raw`[\w$.]+(?:\(\))?`;
const DIR = (name: string) => String.raw`path\.join\(\s*${HOME}\s*,\s*"\.config"\s*,\s*"${name}"\s*\)`;
const RULE = new RegExp(
  String.raw`[\w$.]+\.ELVES_CONFIG_DIR\s*\|\|\s*[\w$.]+\.AI_DEV_CONFIG_DIR\s*\|\|\s*\[\s*${DIR("elves")}\s*,\s*${DIR("ai-dev")}\s*,?\s*\]\.find\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*existsSync\(\s*\1\s*\)\s*\)\s*\|\|\s*${DIR("elves")}`,
  "g",
);
// обращение к каталогу в коде: переменная или путь по умолчанию под любым из имён; `$ELVES_CONFIG_DIR` и
// `~/.config/elves` — текст справки
const MENTION = /(?<![$\w])(?:ELVES|AI_DEV)_CONFIG_DIR\b|(?<!~\/)\.config(?:\/|["'`]\s*,\s*["'`])(?:elves|ai-dev)\b/g;

/** Обращения к каталогу мимо правила — `файл:строка`; комментарии не в счёт. */
function violations(f: SourceFile): string[] {
  const rest = codeOnly(f.text, f.file).replace(RULE, (m) => m.replace(/[^\n]/g, " "));
  return [...rest.matchAll(MENTION)].map((m) => `${f.file}:${rest.slice(0, m.index).split("\n").length} — каталог личной конфигурации мимо правила: ${m[0]}`);
}

/** Скрипту нужен каталог личной конфигурации: в коде названа переменная или путь по умолчанию. */
const needsConfigDir = (f: SourceFile): boolean => codeOnly(f.text, f.file).search(MENTION) >= 0;

const INSTALLER =
  "установщик каталог не вычисляет, а готовит место по умолчанию: `update -g` переносит `~/.config/ai-dev` в `~/.config/elves`, `install -g` с `ELVES_PRIVATE` делает его симлинком на личный чекаут; " +
  "`ELVES_CONFIG_DIR` переопределяет каталог целиком — симлинк ей не нужен, скиллы смотрят туда, куда она указывает";

describe("Каждый скрипт, которому нужен каталог личной конфигурации, берёт его из ELVES_CONFIG_DIR, иначе ~/.config/elves, а до переноса — из прежнего ~/.config/ai-dev", () => {
  invariant(it, {
    registry: "скрипты скиллов и установщик, которым нужен каталог личной конфигурации",
    items: sources(ROOT, ["skills", "bin"]).filter(needsConfigDir),
    key: (f) => f.file,
    name: (f) => `${f.file} берёт каталог из ELVES_CONFIG_DIR, иначе ~/.config/elves, до переноса — ~/.config/ai-dev`,
    check: (f) => {
      const found = violations(f);
      if (found.length) throw new Error(found.join("\n"));
    },
    violator: [
      { name: "скрипт со своим путём каталога личной конфигурации", item: source("skills/x/scripts/x.ts", 'const DIR = path.join(os.homedir(), ".config", "elves");\n') },
      {
        name: "скрипт читает ELVES_CONFIG_DIR, а каталог по умолчанию у него свой",
        item: source("skills/x/scripts/x.ts", 'const DIR = process.env.ELVES_CONFIG_DIR || path.join(os.homedir(), ".elves");\n'),
      },
      {
        name: "скрипт с прежним выражением — не видит ни новую переменную, ни новый каталог",
        item: source("skills/x/scripts/x.ts", 'const DIR = process.env.AI_DEV_CONFIG_DIR || path.join(os.homedir(), ".config", "ai-dev");\n'),
      },
    ],
    // скрипт, ушедший и от переменной, и от пути, выпал бы из реестра молча
    includes: ["skills/est/scripts/est.ts", "skills/github/scripts/github.ts", "skills/slot/scripts/slot.ts", "bin/elves.ts"],
    outside: [{ item: "bin/elves.ts", reason: INSTALLER }],
  });

  describe("примеры", () => {
    const rule = 'env.ELVES_CONFIG_DIR || env.AI_DEV_CONFIG_DIR || [path.join(home, ".config", "elves"), path.join(home, ".config", "ai-dev")].find((d) => existsSync(d)) || path.join(home, ".config", "elves")';

    it("правило с окружением и домашним каталогом под любым именем — чисто", () => {
      expect(violations(source("x.ts", `const dir = ${rule};\n`))).toEqual([]);
      const other = rule.replaceAll("env.", "process.env.").replaceAll("home", "os.homedir()");
      expect(violations(source("y.ts", `export const DIR = ${other};\n`))).toEqual([]);
    });

    it("пустая переменная — тоже каталог по умолчанию: `??` вместо `||` — нарушение", () => {
      const nullish = rule.replace("env.ELVES_CONFIG_DIR || env.AI_DEV_CONFIG_DIR", "(env.ELVES_CONFIG_DIR ?? env.AI_DEV_CONFIG_DIR)");
      expect(violations(source("x.ts", `const dir = ${nullish};\n`)).length).toBeGreaterThan(0);
    });

    it("без прежнего каталога машина до update -g потеряла бы конфигурацию — нарушение", () => {
      const text = 'const dir = env.ELVES_CONFIG_DIR || env.AI_DEV_CONFIG_DIR || path.join(home, ".config", "elves");\n';
      expect(violations(source("x.ts", text)).length).toBeGreaterThan(0);
    });

    it("правило есть, а рядом второй путь к каталогу — нарушение со строкой", () => {
      const text = `const dir = ${rule};\nconst cache = \`\${home}/.config/elves/cache\`;\n`;
      expect(violations(source("x.ts", text))).toEqual(["x.ts:2 — каталог личной конфигурации мимо правила: .config/elves"]);
    });

    it("комментарий и текст справки (~/.config/elves, $ELVES_CONFIG_DIR) — не обращение к каталогу", () => {
      const text = '// ELVES_CONFIG_DIR, иначе ~/.config/elves\nconst HELP = "файл в ~/.config/elves (или в $ELVES_CONFIG_DIR)";\n';
      const f = source("x.ts", text);
      expect([needsConfigDir(f), violations(f)]).toEqual([false, []]);
    });
  });
});
