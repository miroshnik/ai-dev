import { execFileSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Таймаут тестов, которые запускают процессы (git, node, bun): `setDefaultTimeout(SPAWN_TIMEOUT)` в файле теста —
 * стандарт `tests/standards/spawn-timeout`, причина там. Не спека.
 */
export const SPAWN_TIMEOUT = 120_000;

/**
 * Исход процесса для `expect(exitOf(r)).toBe(код)`: код выхода, а если кода нет — ошибка запуска или сигнал с хвостом
 * stderr, чтобы падение объясняло себя (крэш рантайма, #136), а не показывало `null`.
 */
export function exitOf(r: SpawnSyncReturns<string>): number | string {
  // bun при ошибке запуска отдаёт status undefined, а не null, как node
  if (r.status != null) return r.status;
  return r.error ? `не запущен: ${r.error.message}` : `убит сигналом ${r.signal}; stderr: ${(r.stderr ?? "").slice(-2000)}`;
}

/** uid и gid `nobody`: от него под root идёт процесс, которому тест отказывает в записи. */
const NOBODY = 65534;
const root = process.getuid?.() === 0;
let setpriv: string | undefined;

/**
 * Команда от непривилегированного пользователя, когда прогон идёт под root (облачная сессия Claude Code, #598): root
 * пишет и в каталог без права записи, и тест отказа в записи проверял бы не то. `setpriv` делает exec без нового
 * процесса — pid и группа процессов те же, тест убивает их как прежде. Не под root — команда как есть.
 */
export function unprivileged(cmd: string, args: string[]): [string, string[]] {
  // путём от PATH прогона: PATH песочницы теста его не знает
  setpriv ??= root ? execFileSync("sh", ["-c", "command -v setpriv"], { encoding: "utf8" }).trim() : "";
  return root ? [setpriv, [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, "--clear-groups", "--", cmd, ...args]] : [cmd, args];
}

/** Каталоги — на запись процессу `unprivileged`: под root — его, со всем внутри; не под root — и так владельца прогона. */
export function unprivilegedOwns(...dirs: string[]) {
  if (root) for (const d of dirs) execFileSync("chown", ["-R", `${NOBODY}:${NOBODY}`, d]);
}
