import { appendFileSync } from "node:fs";

/**
 * Preload песочницы справки (`tests/lib/cli.ts`): `fetch` дочернего bun записывает обращение в журнал `$CLI_NET` и
 * отказывает — справке сеть не нужна, а слушать порт ради ловушки нельзя: в песочнице агента его нет
 * (`tests/standards/fast-tests`). Скрипты флоу ходят в сеть только `fetch` и командами (`gh`, `git` — заглушки). Не спека.
 */
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    appendFileSync(process.env.CLI_NET!, `fetch ${url}\n`);
    throw new TypeError(`network is off in the help sandbox: ${url}`);
  },
  { preconnect: () => {} },
) as typeof fetch;
