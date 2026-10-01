#!/usr/bin/env bun
/**
 * spec-run — успешный прогон workflow на коммите для публикации спеки на мерж PR (без CI на main): id прогона — в
 * stdout, артефакт `docs-spec` из него скачивает `gh run download`. Прогоны ищутся без фильтра по статусу: выдача
 * `gh run list --status success` отстаёт от завершения прогона на минуты, и только что успешный прогон головы PR в
 * ней ещё не виден — публикация сразу после мержа падала бы, а ветка spec отставала до следующего мержа.
 *
 * Из прогонов workflow на коммите: есть успешный — он (новейший); есть идущий — опрос до его исхода; все завершились
 * неуспешно — ошибка с их исходами сразу, ждать нечего; прогонов нет — опрос до потолка, затем ошибка.
 *
 *   bun spec-run.ts --commit <sha> [--workflow ci.yml] [--timeout 1800] [--interval 15]
 *
 * Коды: 0 — найден, 1 — прогон завершился неуспешно или к потолку успешного нет, 2 — ошибка вызова (аргументы, gh).
 * Запуск — Bun или Node ≥ 22.18, без зависимостей; нужен `gh` с токеном (в Actions — `GH_TOKEN`, `actions: read`).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = "spec-run.ts --commit <sha> [--workflow ci.yml] [--timeout 1800] [--interval 15]";

interface Run {
  databaseId: number;
  status: string;
  conclusion: string | null;
  url: string;
}

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function runs(workflow: string, commit: string): Run[] {
  try {
    const out = execFileSync("gh", ["run", "list", "--workflow", workflow, "--commit", commit, "--json", "databaseId,status,conclusion,url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as Run[];
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Fail(`gh run list: ${stderr || (e as Error).message.split("\n")[0]}`, 2);
  }
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
          commit: { type: "string" },
          workflow: { type: "string", default: "ci.yml" },
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
    if (!v.commit) throw new Fail(`нужен --commit <sha>\n${USAGE}`, 2);
    const timeout = seconds("timeout", v.timeout);
    const interval = seconds("interval", v.interval);
    const at = `${v.workflow} на ${v.commit.slice(0, 12)}`;
    const deadline = Date.now() + timeout * 1000;
    let said = "";
    for (;;) {
      const all = runs(v.workflow, v.commit);
      // выдача — новейшие первыми: из нескольких успешных берётся последний
      const ok = all.find((r) => r.status === "completed" && r.conclusion === "success");
      if (ok) {
        console.error(`spec-run: прогон ${at}: ${ok.databaseId} успешен — ${ok.url}`);
        process.stdout.write(`${ok.databaseId}\n`);
        return 0;
      }
      const going = all.filter((r) => r.status !== "completed");
      if (all.length && !going.length) {
        throw new Fail(`прогон ${at} завершился неуспешно — публиковать нечего: ${all.map((r) => `${r.databaseId} ${r.conclusion} ${r.url}`).join(", ")}`, 1);
      }
      if (Date.now() >= deadline) {
        throw new Fail(going.length ? `прогон ${at}: ${going.map((r) => r.databaseId).join(", ")} не завершился за ${timeout} с` : `нет прогона ${at} за ${timeout} с — публиковать нечего`, 1);
      }
      const now = going.length ? `прогон ${at}: ${going.map((r) => `${r.databaseId} ${r.status}`).join(", ")} — ждём` : `прогона ${at} ещё нет — ждём`;
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
