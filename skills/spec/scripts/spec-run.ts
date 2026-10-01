#!/usr/bin/env bun
/**
 * spec-run — зелёный прогон, проверивший дерево коммита мержа, для публикации спеки на мерж PR (без CI на main): id
 * прогона — в stdout, артефакт `docs-spec-<hash дерева>` из него скачивает `gh run download`. Прогон PR проверяет
 * merge-ref и называет артефакт по его дереву; у коммита мержа дерево то же, только если между стартом прогона и
 * мержем в main ничего не влили — тогда main проверен целиком. Влит отставший PR — такого артефакта нет, и публикация
 * пропускается: из прогона его головы она откатила бы ветку spec (в ней не стало бы страниц PR, влитого раньше).
 *
 * Из прогонов этого репозитория с не истёкшим артефактом дерева: есть зелёный — он (новейший); есть идущий — опрос до
 * его исхода, к потолку не завершился — ошибка; иначе (артефакта нет, истёк, из форка, прогон не зелёный) — пропуск:
 * код 0, stdout пуст, причина — строкой в stderr.
 *
 *   bun spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]
 *
 * Коды: 0 — найден или публикация пропущена, 1 — прогон не завершился к потолку, 2 — ошибка вызова (аргументы, gh).
 * Запуск — Bun или Node ≥ 22.18, без зависимостей; нужен `gh` с токеном (в Actions — `GH_TOKEN`, `actions: read`).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = "spec-run.ts --tree <hash> [--timeout 1800] [--interval 15]";

interface Artifact {
  name: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_repository_id: number } | null;
}

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function api<T>(endpoint: string): T {
  try {
    return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as T;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Fail(`gh api ${endpoint}: ${stderr || (e as Error).message.split("\n")[0]}`, 2);
  }
}

/**
 * Прогоны с живым артефактом дерева. В счёт идут только прогоны этого репозитория: артефакт с любым именем может
 * выложить и прогон PR из форка. Исход — отдельным запросом прогона: артефакт выкладывается посреди прогона и
 * зелёного исхода не доказывает.
 */
function runs(artifact: string): Run[] {
  const { artifacts } = api<{ artifacts: Artifact[] }>(`repos/{owner}/{repo}/actions/artifacts?name=${artifact}`);
  const own = artifacts.filter((a) => !a.expired && a.workflow_run && a.workflow_run.head_repository_id === a.workflow_run.repository_id);
  // перезапуск прогона выкладывает артефакт заново под тем же id прогона
  const ids = [...new Set(own.map((a) => a.workflow_run!.id))];
  return ids.map((id) => api<Run>(`repos/{owner}/{repo}/actions/runs/${id}`));
}

const seconds = (name: string, value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Fail(`--${name}: нужно число секунд, а не «${value}»\n${USAGE}`, 2);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  try {
    let opts;
    try {
      opts = parseArgs({
        args: argv,
        options: {
          tree: { type: "string" },
          timeout: { type: "string", default: "1800" },
          interval: { type: "string", default: "15" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (e) {
      throw new Fail(`${(e as Error).message}\n${USAGE}`, 2);
    }
    const v = opts.values;
    if (v.help) {
      console.error(USAGE);
      return 0;
    }
    if (!v.tree) throw new Fail(`нужен --tree <hash>\n${USAGE}`, 2);
    if (!/^[0-9a-f]{40,64}$/.test(v.tree)) throw new Fail(`--tree: нужен полный хеш дерева (git rev-parse 'HEAD^{tree}'), а не «${v.tree}»\n${USAGE}`, 2);
    const timeout = seconds("timeout", v.timeout);
    const interval = seconds("interval", v.interval);
    const artifact = `docs-spec-${v.tree}`;
    const at = `дерево main ${v.tree.slice(0, 12)}`;
    const deadline = Date.now() + timeout * 1000;
    let said = "";
    for (;;) {
      const all = runs(artifact);
      // выдача — новейшие первыми: из нескольких зелёных берётся последний
      const ok = all.find((r) => r.status === "completed" && r.conclusion === "success");
      if (ok) {
        console.error(`spec-run: ${at}: прогон ${ok.id} успешен — ${ok.html_url}`);
        process.stdout.write(`${ok.id}\n`);
        return 0;
      }
      const going = all.filter((r) => r.status !== "completed");
      if (!going.length) {
        // не ошибка: влит отставший PR — такой main не проверял ни один прогон, ветка spec ждёт следующего мержа
        const why = all.length ? all.map((r) => `${r.id} ${r.conclusion} ${r.html_url}`).join(", ") : `артефакта ${artifact} нет`;
        console.error(`spec-run: ${at} не проверено целиком — публикация пропущена: ${why}`);
        return 0;
      }
      if (Date.now() >= deadline) throw new Fail(`${at}: прогон ${going.map((r) => r.id).join(", ")} не завершился за ${timeout} с`, 1);
      const now = `${at}: прогон ${going.map((r) => `${r.id} ${r.status}`).join(", ")} — ждём`;
      // в лог — только смена состояния, а не строка на каждый опрос
      if (now !== said) console.error(`spec-run: ${(said = now)}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval * 1000, Math.max(0, deadline - Date.now()))));
    }
  } catch (e) {
    console.error(`spec-run: ${(e as Error).message}`);
    return e instanceof Fail ? e.code : 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
