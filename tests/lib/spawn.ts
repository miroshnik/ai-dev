import type { SpawnSyncReturns } from "node:child_process";

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
