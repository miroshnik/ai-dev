import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// правило — одно выражение: переменная, иначе каталог по умолчанию; `||`, а не `??` — пустая переменная тоже «иначе»
const RULE = /[\w$.]+\.AI_DEV_CONFIG_DIR\s*\|\|\s*path\.join\(\s*[\w$.]+(?:\(\))?\s*,\s*"\.config"\s*,\s*"ai-dev"\s*\)/g;
// обращение к каталогу в коде: переменная или путь по умолчанию; `$AI_DEV_CONFIG_DIR` и `~/.config/ai-dev` — текст справки
const MENTION = /(?<![$\w])AI_DEV_CONFIG_DIR\b|(?<!~\/)\.config(?:\/|["'`]\s*,\s*["'`])ai-dev\b/g;

/** Обращения к каталогу мимо правила — `файл:строка`; комментарии не в счёт. */
function violations(f: SourceFile): string[] {
  const rest = codeOnly(f.text, f.file).replace(RULE, (m) => m.replace(/[^\n]/g, " "));
  return [...rest.matchAll(MENTION)].map((m) => `${f.file}:${rest.slice(0, m.index).split("\n").length} — каталог личной конфигурации мимо правила: ${m[0]}`);
}

/** Скрипту нужен каталог личной конфигурации: в коде названа переменная или путь по умолчанию. */
const needsConfigDir = (f: SourceFile): boolean => codeOnly(f.text, f.file).search(MENTION) >= 0;

const INSTALLER =
  "установщик каталог не вычисляет, а готовит место по умолчанию: `install -g` с `AI_DEV_PRIVATE` делает `~/.config/ai-dev` симлинком на личный чекаут; " +
  "`AI_DEV_CONFIG_DIR` переопределяет каталог целиком — симлинк ей не нужен, скиллы смотрят туда, куда она указывает";

describe("Каждый скрипт, которому нужен каталог личной конфигурации, берёт его из AI_DEV_CONFIG_DIR, иначе ~/.config/ai-dev", () => {
  invariant(it, {
    registry: "скрипты скиллов и установщик, которым нужен каталог личной конфигурации",
    items: sources(ROOT, ["skills", "bin"]).filter(needsConfigDir),
    key: (f) => f.file,
    name: (f) => `${f.file} берёт каталог из AI_DEV_CONFIG_DIR, иначе ~/.config/ai-dev`,
    check: (f) => {
      const found = violations(f);
      if (found.length) throw new Error(found.join("\n"));
    },
    violator: [
      { name: "скрипт со своим путём каталога личной конфигурации", item: source("skills/x/scripts/x.ts", 'const DIR = path.join(os.homedir(), ".config", "ai-dev");\n') },
      {
        name: "скрипт читает AI_DEV_CONFIG_DIR, а каталог по умолчанию у него свой",
        item: source("skills/x/scripts/x.ts", 'const DIR = process.env.AI_DEV_CONFIG_DIR || path.join(os.homedir(), ".ai-dev");\n'),
      },
    ],
    // скрипт, ушедший и от переменной, и от пути, выпал бы из реестра молча
    includes: ["skills/est/scripts/est.ts", "skills/github/scripts/github.ts", "bin/ai-dev.mjs"],
    outside: [{ item: "bin/ai-dev.mjs", reason: INSTALLER }],
  });

  describe("примеры", () => {
    const rule = 'env.AI_DEV_CONFIG_DIR || path.join(home, ".config", "ai-dev")';

    it("правило с окружением и домашним каталогом под любым именем — чисто", () => {
      expect(violations(source("x.ts", `const dir = ${rule};\n`))).toEqual([]);
      expect(violations(source("y.ts", 'export const DIR = process.env.AI_DEV_CONFIG_DIR || path.join(os.homedir(), ".config", "ai-dev");\n'))).toEqual([]);
    });

    it("пустая переменная — тоже каталог по умолчанию: `??` вместо `||` — нарушение", () => {
      expect(violations(source("x.ts", `const dir = ${rule.replace("||", "??")};\n`))).toHaveLength(2);
    });

    it("правило есть, а рядом второй путь к каталогу — нарушение со строкой", () => {
      const text = `const dir = ${rule};\nconst cache = \`\${home}/.config/ai-dev/cache\`;\n`;
      expect(violations(source("x.ts", text))).toEqual(["x.ts:2 — каталог личной конфигурации мимо правила: .config/ai-dev"]);
    });

    it("комментарий и текст справки (~/.config/ai-dev, $AI_DEV_CONFIG_DIR) — не обращение к каталогу", () => {
      const text = '// AI_DEV_CONFIG_DIR, иначе ~/.config/ai-dev\nconst HELP = "файл в ~/.config/ai-dev (или в $AI_DEV_CONFIG_DIR)";\n';
      const f = source("x.ts", text);
      expect([needsConfigDir(f), violations(f)]).toEqual([false, []]);
    });
  });
});
