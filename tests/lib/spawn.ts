/**
 * Таймаут тестов, которые запускают процессы (git, node, bun): `setDefaultTimeout(SPAWN_TIMEOUT)` в файле теста —
 * стандарт `tests/standards/spawn-timeout`, причина там. Не спека.
 */
export const SPAWN_TIMEOUT = 120_000;
