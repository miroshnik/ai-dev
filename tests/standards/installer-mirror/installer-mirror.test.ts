import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALLER = "bin/ai-dev.mjs";

/** Оригинал копии: файл скилла от корня проекта и имя в нём — экспорт скрипта или переменная подстановки compose-файла. */
interface Original {
  file: string;
  name: string;
}

/** Копия значения скилла в установщике: константа под JSDoc с метками `@mirror <файл> <имя>`. */
interface Copy {
  name: string;
  line: number;
  originals: Original[];
  /** Значение литерала; не литерал или константы под меткой нет — `error`. */
  value?: unknown;
  error?: string;
}

const JSDOC = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\n?([^\n]*)/g;
const MIRROR = /@mirror\s+(\S+)\s+(\S+)/g;
const CONST = /^const (\w+) = (.+);$/;

/** Копии в тексте установщика: каждый JSDoc с `@mirror` — копия, даже если константы-литерала под ним нет. */
function copies(text: string): Copy[] {
  const out: Copy[] = [];
  for (const m of text.matchAll(JSDOC)) {
    const originals = [...m[1]!.matchAll(MIRROR)].map(([, file, name]) => ({ file: file!, name: name! }));
    if (!originals.length) continue;
    const line = text.slice(0, m.index! + m[0].length).split("\n").length;
    const decl = CONST.exec(m[2]!);
    if (!decl) {
      out.push({ name: m[2]!.trim() || "(пусто)", line, originals, error: "под меткой @mirror нет константы `const X = <литерал>;`" });
      continue;
    }
    try {
      out.push({ name: decl[1]!, line, originals, value: JSON.parse(decl[2]!) });
    } catch {
      out.push({ name: decl[1]!, line, originals, error: `значение ${decl[2]} — не литерал: копия пишется литералом, как в оригинале` });
    }
  }
  return out;
}

/** Значения по умолчанию подстановки `${<имя>:-<значение>}` в compose-файле — каждое вхождение; комментарии не в счёт. */
const composeDefaults = (text: string, name: string) =>
  [...text.replace(/(^|\s)#.*$/gm, "$1").matchAll(new RegExp(`\\$\\{${name}:-([^}]*)\\}`, "g"))].map((m) => m[1]!);

/** Значения оригинала: экспорт скрипта скилла — одно, compose-файл — по одному на вхождение подстановки. */
async function originalValues(o: Original): Promise<unknown[]> {
  const file = path.join(ROOT, o.file);
  if (/\.(?:ts|mjs|js)$/.test(o.file)) {
    const mod = (await import(file)) as Record<string, unknown>;
    if (!(o.name in mod)) throw new Error(`${o.file}: нет экспорта ${o.name}`);
    return [mod[o.name]];
  }
  if (/\.ya?ml$/.test(o.file)) {
    const found = composeDefaults(readFileSync(file, "utf8"), o.name);
    if (!found.length) throw new Error(`${o.file}: нет подстановки \${${o.name}:-…}`);
    return found;
  }
  throw new Error(`${o.file}: оригинал — скрипт скилла (.ts) или compose-файл (.yaml)`);
}

async function check(c: Copy) {
  if (c.error) throw new Error(`${INSTALLER}:${c.line} ${c.name}: ${c.error}`);
  const diffs: string[] = [];
  for (const o of c.originals) {
    for (const v of await originalValues(o)) {
      if (!isDeepStrictEqual(v, c.value)) diffs.push(`${INSTALLER}:${c.line} ${c.name} = ${JSON.stringify(c.value)}, а ${o.name} в ${o.file} — ${JSON.stringify(v)}`);
    }
  }
  if (diffs.length) throw new Error(diffs.join("\n"));
}

const of = (o: Original) => (/\.ya?ml$/.test(o.file) ? `\${${o.name}:-…} в ${o.file}` : `${o.name} из ${o.file}`);

const doc = (tags: string[], decl: string) => `/**\n * Копия.\n${tags.map((t) => ` * @mirror ${t}\n`).join("")} */\n${decl}\n`;
const SCRIPT = "skills/task-env/scripts/task-env.ts";
const PROXY_COMPOSE = "skills/task-env/proxy/compose.yaml";

describe("Значение скилла, которое установщик держит копией, совпадает с оригиналом", () => {
  invariant(it, {
    registry: "копии значений скилла в установщике",
    items: copies(readFileSync(path.join(ROOT, INSTALLER), "utf8")),
    key: (c) => c.name,
    name: (c) => `${c.name} установщика совпадает с ${c.originals.map(of).join(" и ")}`,
    check,
    violator: [
      {
        name: "в копии COMPOSE_FILES лишнее имя compose-файла",
        item: copies(doc([`${SCRIPT} COMPOSE_FILES`], 'const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "container-compose.yaml"];'))[0]!,
      },
      { name: "имя прокси в установщике не то, что в compose-файле прокси", item: copies(doc([`${PROXY_COMPOSE} AI_DEV_PROXY`], 'const PROXY = "other-proxy";'))[0]! },
    ],
    // копия, у которой потеряли метку, выпала бы из реестра молча
    includes: ["COMPOSE_FILES", "PROXY"],
  });

  describe("примеры", () => {
    it("метка @mirror без константы-литерала под ней — нарушение, а не пропуск", async () => {
      const [fn, expr] = [copies(doc([`${SCRIPT} PROXY`], "function proxy() {}")), copies(doc([`${SCRIPT} PROXY`], "const PROXY = process.env.X || 'ai-dev-proxy';"))];
      expect([fn.length, expr.length]).toEqual([1, 1]);
      await expect(check(fn[0]!)).rejects.toThrow("нет константы");
      await expect(check(expr[0]!)).rejects.toThrow("не литерал");
    });

    it("JSDoc без @mirror — не копия", () => {
      expect(copies('/** Список. */\nconst LIST = ["a"];\n')).toEqual([]);
    });

    it("у копии несколько оригиналов: сверяется с каждым", () => {
      const [c] = copies(doc([`${SCRIPT} PROXY`, `${PROXY_COMPOSE} AI_DEV_PROXY`], 'const PROXY = "ai-dev-proxy";'));
      expect(c).toEqual({
        name: "PROXY",
        line: 6,
        value: "ai-dev-proxy",
        originals: [
          { file: SCRIPT, name: "PROXY" },
          { file: PROXY_COMPOSE, name: "AI_DEV_PROXY" },
        ],
      });
    });

    it("compose-файл: каждое вхождение ${<имя>:-…} — отдельное значение, другие переменные и комментарии не в счёт", () => {
      const text = "# по умолчанию ${AI_DEV_PROXY:-…}\nname: ${AI_DEV_PROXY:-a} # ${AI_DEV_PROXY:-c}\nnetwork: ${AI_DEV_PROXY:-b}\nport: ${AI_DEV_PROXY_PORT:-80}\n";
      expect(composeDefaults(text, "AI_DEV_PROXY")).toEqual(["a", "b"]);
    });
  });
});
