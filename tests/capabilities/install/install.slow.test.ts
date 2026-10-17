import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { PACKAGE_BUNX } from "../../../skills/spec/scripts/package-run.ts";
import { elves, elvesPackage, sandbox, type Sandbox } from "../../lib/elves.ts";
import { npmRegistry, type Registry } from "../../lib/registry.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/** Версия пакета в фейковом реестре: в настоящем npm такой нет — bunx не возьмёт её из кеша машины. */
const VERSION = "2026.1017.608";
const YARN = "yarn@4.9.1";

let packages: { dir: string; cleanup: () => void };
let registry: Registry;
let sb: Sandbox;

beforeAll(async () => {
  packages = tmpDir();
  registry = await npmRegistry([VERSION], elvesPackage(path.join(packages.dir, "src")).dir);
});
afterAll(() => {
  registry.stop();
  packages.cleanup();
});

/**
 * Песочница с настоящим Yarn: corepack ставит его по `packageManager` из реестра npm — сеть, кеш corepack — в HOME
 * песочницы; Node для Yarn, `jq` для версии пакета проекта и bunx — с машины, bunx — того же Bun, что прогон.
 */
beforeEach(() => {
  sb = sandbox();
  const tools = ["node", "corepack", "jq"];
  const found = spawnSync("sh", ["-c", tools.map((t) => `command -v ${t}`).join(" && ")], { encoding: "utf8" });
  if (found.status !== 0) throw new Error(`для теста нужны ${tools.join(", ")}: ${found.stdout}${found.stderr}`);
  found.stdout.trim().split("\n").forEach((p, i) => symlinkSync(p, path.join(sb.bin, tools[i]!)));
  symlinkSync(process.execPath, path.join(sb.bin, "bunx"));
});
afterEach(() => sb.cleanup());

/**
 * Окружение Yarn и скриптов: реестр пакета — фейковый (`npm_config_registry` читает и bun), Yarn — из реестра npm;
 * корневые сертификаты Node — машины: облачная сессия подменяет TLS своим прокси.
 */
const env = () => {
  const ca = process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {};
  return { ...sb.env, ...registry.env, ...ca, COREPACK_NPM_REGISTRY: "https://registry.npmjs.org", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
};

/**
 * Проект на Yarn 4: пакет версии VERSION в devDependencies, `.yarnrc.yml` с `nodeLinker` и реестром — фейковым, кеш
 * Yarn — в проекте; ключ в `.env.local` — его не должна увидеть ни одна команда скрипта.
 */
function yarnProject(linker: "pnp" | "node-modules", scripts: Record<string, string>) {
  writeTree(sb.proj, {
    "package.json": JSON.stringify({ name: "probe", private: true, packageManager: YARN, devDependencies: { "@miroshnik/elves": VERSION }, scripts }, null, 2) + "\n",
    ".yarnrc.yml": [`nodeLinker: ${linker}`, `npmRegistryServer: "${registry.url.replace(/\/$/, "")}"`, 'unsafeHttpWhitelist: ["127.0.0.1"]', "enableGlobalCache: false", "enableTelemetry: false", ""].join("\n"),
    ".env.local": "ELVES_LEAK=prod-key\n",
    "yarn.lock": "",
  });
}

/** `yarn <args>` через corepack в проекте песочницы. */
function yarn(...args: string[]) {
  const r = spawnSync("corepack", ["yarn", ...args], { cwd: sb.proj, env: env(), encoding: "utf8" });
  return { code: exitOf(r), out: `${r.stdout}${r.stderr}` };
}

const scripts = () => JSON.parse(readFileSync(path.join(sb.proj, "package.json"), "utf8")).scripts as Record<string, string>;

/** Команда проверки: переменная слота очереди и ключ env-файла — `[<слот>|<ключ>]`. */
const PROBE = `echo "[$ELVES_SLOT|$ELVES_LEAK]"`;
const IN_SLOT = /^\[\d+-\d+\|\]$/m;

/**
 * Yarn 2+ запускает bin пакета `.ts` Node-ом, мимо шебанга, при любом `nodeLinker` (`isNodeScript` Yarn), а Node не
 * снимает типы у файлов под `node_modules`; с PnP `node_modules` нет вовсе. Строка в package.json, верная по тексту, не
 * запускалась — проверка настоящим Yarn: скрипт идёт пакетом версии проекта через bunx (`PACKAGE_BUNX`), bin — шебангом
 * под Bun без env-файлов (#592, #608).
 */
describe("Тонкий проект на Yarn 2+: скрипт пакета и обёртка очереди запускают bin пакета под Bun", () => {
  it("проверка проекта на Yarn 2+ через очередь машины запускает bin пакета под Bun — и с PnP, и с nodeLinker node-modules", () => {
    for (const linker of ["pnp", "node-modules"] as const) {
      yarnProject(linker, { test: PROBE });
      expect(elves(sb, ["install", "--no-auto", "--lang", "en"]).code).toBe(0);
      expect(scripts().test).toBe(`${PACKAGE_BUNX} slot '${PROBE}'`);
      const installed = yarn("install");
      expect(installed.code, installed.out).toBe(0);
      expect(existsSync(path.join(sb.proj, "node_modules"))).toBe(linker === "node-modules");
      const r = yarn("test");
      expect({ linker, code: r.code, slot: IN_SLOT.test(r.out) }, r.out).toEqual({ linker, code: 0, slot: true });
      for (const f of ["node_modules", ".pnp.cjs", ".pnp.loader.mjs", ".yarn", ".agents", "AGENTS.md"]) rmSync(path.join(sb.proj, f), { recursive: true, force: true });
    }
  });

  it("install и update на Yarn 2+ с PnP — скрипт пакета в package.json в форме, которая работает без node_modules", () => {
    // скрипт копии флоу и обёртка Yarn 2+ до #608 — `elves slot`, его Yarn запускал Node-ом
    const copy = "bun --no-env-file .agents/skills/spec/scripts/spec-exceptions.ts";
    yarnProject("pnp", { "spec:exceptions": copy, lint: `elves slot '${PROBE}'` });
    expect(elves(sb, ["install", "--no-auto", "--lang", "en"]).code).toBe(0);
    expect(scripts()).toEqual({ "spec:exceptions": `${PACKAGE_BUNX} spec-exceptions`, lint: `${PACKAGE_BUNX} slot '${PROBE}'` });
    // проверка с командой копии внутри: строка команды в одинарных кавычках — `'\''` в shell Yarn
    const pkg = JSON.parse(readFileSync(path.join(sb.proj, "package.json"), "utf8"));
    writeFileSync(path.join(sb.proj, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, lint: `elves slot '${PROBE}'`, "test:spec": `elves slot '${copy}'` } }, null, 2) + "\n");
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(scripts()["test:spec"]).toBe(`${PACKAGE_BUNX} slot '${PACKAGE_BUNX.replaceAll("'", "'\\''")} spec-exceptions'`);
    expect(yarn("install").code).toBe(0);
    expect(existsSync(path.join(sb.proj, "node_modules"))).toBe(false);
    // spec-exceptions пакета в проекте без exceptions.ts: переносить нечего, код 0
    const nothing = expect.stringMatching(/exceptions\.ts in decision folders — nothing to move/);
    const runs = Object.fromEntries(["spec:exceptions", "lint", "test:spec"].map((s) => [s, yarn(s)]));
    expect(runs).toEqual({ "spec:exceptions": { code: 0, out: nothing }, lint: { code: 0, out: expect.stringMatching(IN_SLOT) }, "test:spec": { code: 0, out: nothing } });
  });
});
