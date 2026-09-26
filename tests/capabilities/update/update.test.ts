/**
 * Проверка и обновление флоу: `ai-dev check` говорит, отстала ли установка от main ai-dev, `ai-dev update` доводит её
 * до актуальной.
 *
 * Правила грузятся в контекст на старте сессии: сессия на отставшем флоу работает по старым правилам, поэтому `check` —
 * первый шаг сессии (AGENTS.md). Он ничего не меняет и отвечает кодом: 0 — актуально, 1 — отстаёт, 2 — проверка
 * недоступна. Копию (проект, машина без `--link`) сверяет свежий пакет — npx берёт его из main при каждом запуске;
 * клон `--link` сверяется с `origin/main` после `git fetch`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, aiDevPackage, copyPackage, REPO, sandbox, snapshot, SPAWN_TIMEOUT, type AiDevPackage, type Sandbox } from "../../lib/ai-dev.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** Пакеты ai-dev собираются один раз на файл: base — как этот клон, newer — ai-dev ушёл вперёд. */
let packages: { dir: string; cleanup: () => void };
let base: AiDevPackage;
let newer: AiDevPackage;
beforeAll(() => {
  packages = tmpDir();
  base = aiDevPackage(path.join(packages.dir, "base"));
  // новое правило в AGENTS.md, новый скилл, скилл ci-wait убран
  newer = aiDevPackage(path.join(packages.dir, "newer"), {
    "AGENTS.md": readFileSync(path.join(REPO, "AGENTS.md"), "utf8") + "\nНовое правило.\n",
    "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n",
    "skills/ci-wait": null,
  });
});
afterAll(() => packages.cleanup());

const read = (p: string) => readFileSync(p, "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);
const manifest = (root: string) => path.join(root, ".agents/ai-dev.json");

/** Установка прошлой версией установщика: в .agents/ai-dev.json нет SHA. */
function dropSha(root: string) {
  const m = JSON.parse(read(manifest(root)));
  delete m.sha;
  writeFileSync(manifest(root), JSON.stringify(m, null, 2) + "\n");
}

/** Машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main. */
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(aiDev(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/ai-dev.mjs") }).code).toBe(0);
  return { up, clone };
}

describe("Проект — копия в .agents", () => {
  it("поставлено из того же ai-dev — актуально, код 0", () => {
    aiDev(sb, ["install"]);
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("в проекте: актуально");
  });

  it("ai-dev ушёл вперёд — отстаёт, код 1: стоит и свежий SHA, что изменится, команда обновления; check ничего не меняет", () => {
    aiDev(sb, ["install"]);
    const before = snapshot(sb.proj);
    const r = aiDev(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`в проекте: отстаёт — стоит ${short(git(REPO, "rev-parse", "HEAD"))}, свежий ${short(newer.sha)}`);
    expect(r.stdout).toContain("~ .agents/ai-dev/AGENTS.md");
    expect(r.stdout).toContain("+ .agents/skills/fresh/");
    expect(r.stdout).toContain("- .agents/skills/ci-wait/");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update\n");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update — копия как у свежего пакета, его SHA в .agents/ai-dev.json, подсказка коммита chore(agents); после него check — актуально", () => {
    aiDev(sb, ["install"]);
    const r = aiDev(sb, ["update"], { bin: newer.bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`chore(agents): флоу ai-dev ${short(newer.sha)}`);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Новое правило.");
    expect(existsSync(path.join(sb.proj, ".agents/skills/fresh/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(sb.proj, ".agents/skills/ci-wait"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
    expect(aiDev(sb, ["check"], { bin: newer.bin }).code).toBe(0);
  });

  it("старая установка без SHA — check сравнивает содержимое: совпадает — актуально, нет — отстаёт «без SHA»; update записывает SHA", () => {
    aiDev(sb, ["install"]);
    dropSha(sb.proj);
    expect(aiDev(sb, ["check"]).code).toBe(0);
    const r = aiDev(sb, ["check"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("стоит без SHA");
    expect(aiDev(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).sha).toBe(newer.sha);
  });

  it("флоу в проекте не стоит — «не установлен», код 0, ничего не создаётся", () => {
    const r = aiDev(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("в проекте: не установлен");
    expect(existsSync(path.join(sb.proj, ".agents"))).toBe(false);
  });
});

describe("Машина — копия в ~/.agents (-g)", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  it("поставлено из того же ai-dev — актуально, код 0", () => {
    aiDev(sb, ["install", "-g"]);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("на машине: актуально");
  });

  it("ai-dev ушёл вперёд — отстаёт, код 1, check ничего не меняет; update -g доводит до актуального", () => {
    aiDev(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("~ ~/.agents/ai-dev/AGENTS.md");
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh/");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(aiDev(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(read(path.join(sb.home, ".agents/ai-dev/AGENTS.md"))).toContain("Новое правило.");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(aiDev(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  it("старая установка без SHA и без хука SessionStart — отстаёт; update -g ставит хук и пишет SHA", () => {
    aiDev(sb, ["install", "-g"]);
    dropSha(sb.home);
    rmSync(path.join(sb.home, ".claude/settings.json"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("стоит без SHA");
    expect(r.stdout).toContain("+ ~/.claude/settings.json");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/settings.json"))).toContain("check --hook");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(git(REPO, "rev-parse", "HEAD"));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });
});

describe("Машина — клон через --link (-g)", () => {
  const RULE = "\nНовое правило.\n";

  it("клон на origin/main — актуально, код 0", () => {
    linkedClone();
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("актуально");
  });

  it("в main новое правило и новый скилл — отстаёт, код 1: файлы флоу из origin/main; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("~ AGENTS.md");
    expect(r.stdout).toContain("+ skills/fresh/SKILL.md");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update -g");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g — git pull --ff-only клона и ссылки на новый скилл; после него check — актуально", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(read(path.join(sb.home, ".agents/ai-dev/AGENTS.md"))).toContain("Новое правило.");
    expect(realpathSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(realpathSync(path.join(sb.home, ".claude/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
  });

  it("коммиты в main без файлов флоу — актуально, код 0", () => {
    const { up } = linkedClone();
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("актуально");
  });

  it("старая установка без SHA — check по git; update -g пишет SHA клона", () => {
    const { up } = linkedClone();
    dropSha(sb.home);
    const sha = up.repo.commit({ "docs/new.md": "# Новый справочник\n" });
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ docs/new.md");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(sha);
  });

  it("update -g: в клоне изменения в отслеживаемых файлах — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "AGENTS.md"), "моя правка\n");
    const head = git(clone, "rev-parse", "HEAD");
    const r = aiDev(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AGENTS.md");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(read(path.join(clone, "AGENTS.md"))).toBe("моя правка\n");
  });

  it("update -g: неотслеживаемые файлы в клоне не мешают", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "notes.txt"), "мои заметки\n");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(read(path.join(clone, "notes.txt"))).toBe("мои заметки\n");
  });

  it("update -g: клон не на main — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    git(clone, "switch", "-q", "-c", "feature");
    const head = git(clone, "rev-parse", "HEAD");
    const r = aiDev(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("не на main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("git fetch не удался (нет сети, нет remote) — проверка недоступна, код 2", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("проверка недоступна");
  });
});

/**
 * Хук SessionStart, который ставит `install -g`, запускает `check --hook`: вывод хука с кодом 0 Claude Code добавляет
 * в контекст сессии, другой код — нет, поэтому код хука всегда 0, а ошибка — в выводе.
 */
describe("Хук SessionStart", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude"), { recursive: true }));

  /** Команда хука из ~/.claude/settings.json — как её запускает Claude Code: через shell, в каталоге проекта. */
  function runHook() {
    const s = JSON.parse(read(path.join(sb.home, ".claude/settings.json")));
    const hooks: { command: string }[] = s.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const command = hooks.find((h) => h.command.includes("check --hook"))!.command;
    const r = spawnSync("sh", ["-c", command], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout };
  }

  /** npx песочницы отдаёт пакет bin: `npx … github:miroshnik/ai-dev <команда>` → `node <bin> <команда>`. */
  function npxServes(bin: string) {
    rmSync(path.join(sb.bin, "npx"));
    const script = `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in github:*) shift; break ;; *) shift ;; esac; done\nexec node "${bin}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "npx"), script, { mode: 0o755 });
  }

  it("команда хука — check --hook: машина и проект одним выводом, код 0, даже когда отстаёт", () => {
    aiDev(sb, ["install", "-g"]);
    aiDev(sb, ["install"]);
    npxServes(newer.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev на машине: отстаёт");
    expect(r.stdout).toContain("ai-dev в проекте: отстаёт");
  });

  it("npx недоступен — код хука 0, в выводе — что проверка недоступна", () => {
    aiDev(sb, ["install", "-g"]);
    rmSync(path.join(sb.bin, "npx"));
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("недоступен");
  });

  it("check --hook: проверка недоступна — объяснение в stdout, код 0", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = aiDev(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("проверка недоступна");
  });
});
