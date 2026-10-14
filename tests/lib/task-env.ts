/**
 * Хелперы для тестов скилла task-env: пути скрипта и compose-файла прокси, запуск команды, подставной gh задач — общие
 * для быстрого `task-env.test.ts` и медленного `task-env.slow.test.ts`. Не спека — в документацию не попадает.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCRIPT = fileURLToPath(new URL("../../skills/task-env/scripts/task-env.ts", import.meta.url));
export const COMPOSE = fileURLToPath(new URL("../../skills/task-env/proxy/compose.yaml", import.meta.url));

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  if (r.error) throw r.error;
  return r;
}

/**
 * Подставной gh: `gh api repos/<репозиторий>/issues/<N>` — состояние задачи из FAKE_GH_STATES («41=closed 42=open»),
 * другого номера нет — 404; аргументы — в журнал FAKE_GH_LOG.
 */
export const FAKE_GH = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
  'n="${2##*/}"',
  "for s in $FAKE_GH_STATES; do",
  '  if [ "${s%%=*}" = "$n" ]; then echo "{\\"number\\": $n, \\"state\\": \\"${s#*=}\\"}"; exit 0; fi',
  "done",
  'echo "gh: Not Found (HTTP 404)" >&2',
  "exit 1",
  "",
].join("\n");

/** Журнал подставной команды: строки вызовов. */
export const calls = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean);
