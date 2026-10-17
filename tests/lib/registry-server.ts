/**
 * Сервер фейкового реестра npm (tests/lib/registry.ts) — отдельным процессом: тесты зовут установщик и менеджер пакетов
 * синхронно, и сервер в процессе теста ждал бы конца каждого вызова. Отдаёт из каталога `<dir>`: метаданные пакета
 * `@miroshnik/elves` — по файлам `<версия>.tgz` в нём, с адресами tarball'ов на свой порт, и сами tarball'ы; рядом с
 * tarball'ом `<версия>.json` — package.json версии, как его отдаёт npm в метаданных (`bin` — по нему bunx находит bin).
 * Порт — первой строкой stdout: `PORT <n>`. Не спека.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [dir = ""] = process.argv.slice(2);
const NAME = "@miroshnik/elves";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const file = /^\/-\/([\w.-]+\.tgz)$/.exec(url.pathname)?.[1];
    if (file && existsSync(path.join(dir, file))) return new Response(readFileSync(path.join(dir, file)));
    if (decodeURIComponent(url.pathname) !== `/${NAME}`) return new Response("{}", { status: 404 });
    const versions = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".tgz"))
        .map((f) => {
          const version = f.slice(0, -".tgz".length);
          const data = readFileSync(path.join(dir, f));
          const dist = {
            tarball: `${url.origin}/-/${f}`,
            integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
            shasum: createHash("sha1").update(data).digest("hex"),
          };
          const manifest = path.join(dir, `${version}.json`);
          return [version, { ...(existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {}), name: NAME, version, dist }];
        }),
    );
    const latest = Object.keys(versions).sort().at(-1) ?? "";
    return Response.json({ name: NAME, "dist-tags": { latest }, versions });
  },
});

process.stdout.write(`PORT ${server.port}\n`);
