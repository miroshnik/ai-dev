import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { aiDev, aiDevPackage, copyPackage, npxPackage, npxServesPackages, REPO, sandbox, snapshot, type AiDevPackage, type Sandbox } from "../../lib/ai-dev.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// пакеты ai-dev собираются один раз на файл: base — как этот клон, newer — ai-dev ушёл вперёд
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

// установка прошлой версией установщика: в .agents/ai-dev.json нет SHA
function dropSha(root: string) {
  const m = JSON.parse(read(manifest(root)));
  delete m.sha;
  writeFileSync(manifest(root), JSON.stringify(m, null, 2) + "\n");
}

// машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(aiDev(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/ai-dev.mjs") }).code).toBe(0);
  return { up, clone };
}

describe("Копия в проекте сверяется со свежим ai-dev и обновляется им", () => {
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

describe("Копия на машине (-g) сверяется и обновляется так же — вместе с хуком SessionStart", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  it("поставлено из того же ai-dev — актуально, код 0", () => {
    aiDev(sb, ["install", "-g"]);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("на машине: актуально");
  });

  it("ai-dev ушёл вперёд (новый скилл) — отстаёт, код 1, check ничего не меняет; update -g доводит до актуального, правил на машине по-прежнему нет", () => {
    aiDev(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh/");
    expect(r.stdout).toContain("npx -y github:miroshnik/ai-dev update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(aiDev(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(aiDev(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  it("поставлено прошлой версией с правилами на машине — отстаёт: в списке «- ~/.agents/ai-dev/» и «- ~/.claude/rules/ai-dev.md»; update -g убирает их, после него check — актуально", () => {
    aiDev(sb, ["install", "-g"]);
    mkdirSync(path.join(sb.home, ".agents/ai-dev"), { recursive: true });
    writeFileSync(path.join(sb.home, ".agents/ai-dev/AGENTS.md"), "старый канон\n");
    mkdirSync(path.join(sb.home, ".claude/rules"), { recursive: true });
    symlinkSync("../../.agents/ai-dev/AGENTS.md", path.join(sb.home, ".claude/rules/ai-dev.md"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
    expect(r.stdout).toContain("- ~/.claude/rules/ai-dev.md");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
    expect(lstatSync(path.join(sb.home, ".claude/rules/ai-dev.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
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

// ai-dev с релизами: upstream — git-репозиторий, откуда установщик берёт теги (AI_DEV_REPO); npx песочницы отдаёт
// пакеты его коммитов — голову main по `github:miroshnik/ai-dev` и релиз по SHA тега
function withReleases() {
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const pkgs = path.join(sb.tmp, "npx");
  npxServesPackages(sb, pkgs);
  const head = () => up.repo.git("rev-parse", "HEAD");
  const serveMain = () => (rmSync(path.join(pkgs, "main"), { recursive: true, force: true }), npxPackage(path.join(pkgs, "main"), up.dir, head()));
  const bin = serveMain();
  return {
    up,
    /** коммит в main upstream: npx теперь отдаёт его */
    commit(files: Record<string, string | null>) {
      const sha = up.repo.commit(files);
      serveMain();
      return sha;
    },
    /** релиз — тег на голову main (annotated — аннотированный), npx отдаёт его пакет по SHA коммита */
    release(tag: string, { annotated = false } = {}) {
      const sha = head();
      if (annotated) up.repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "tag", "-a", "-m", tag, tag);
      else up.repo.git("tag", tag);
      npxPackage(path.join(pkgs, sha), up.dir, sha);
      return sha;
    },
    /** установщик — пакет npx из main, как его запускает `npx -y github:miroshnik/ai-dev` */
    run: (args: string[], env: Record<string, string> = {}) => aiDev(sb, args, { bin, env: { AI_DEV_REPO: up.dir, ...env } }),
  };
}

/**
 * Проекты и машина копией следуют за релизами ai-dev (теги vГГГГ.ММ.ДД), а не за main: коммит в main без релиза их
 * «отставшими» не делает. Пакет npx из main находит последний релиз и перезапускается из него — дальше и код, и
 * файлы релиза.
 */
describe("Копия следует за релизами ai-dev, а не за main", () => {
  const rule = (up: AiDevPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });

  it("install ставит последний релиз, а не голову main: его файлы, тег и SHA в .agents/ai-dev.json", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило из main."));
    expect(r.run(["install"]).code).toBe(0);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).not.toContain("Правило из main.");
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.05", sha });
  });

  it("main ушёл вперёд, нового релиза нет — актуально, код 0", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("в проекте: актуально (v2026.10.05)");
  });

  it("вышел релиз новее установленного — отстаёт, код 1: стоящий и свежий тег; check ничего не меняет", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    const before = snapshot(sb.proj);
    const c = r.run(["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("в проекте: отстаёт — стоит v2026.10.05, свежий v2026.10.12");
    expect(c.stdout).toContain("~ .agents/ai-dev/AGENTS.md");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update ставит последний релиз, а не голову main; подсказка коммита — с тегом; после него check — актуально", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    const sha = r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."));
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("chore(agents): флоу ai-dev v2026.10.12");
    const agents = read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"));
    expect(agents).toContain("Правило релиза.");
    expect(agents).not.toContain("Правило из main.");
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.12", sha });
    expect(r.run(["check"]).code).toBe(0);
  });

  /** Аннотированный тег ls-remote отдаёт объектом тега — ставится коммит, на который он указывает. */
  it("последний релиз — по дате, затем по номеру патча; аннотированный тег — его коммит; чужие теги не в счёт", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Патч."));
    const sha = r.release("v2026.10.05.1", { annotated: true });
    r.commit(rule(r.up, "Правило из main."));
    r.release("v2026.09.30");
    r.up.repo.git("tag", "v9.0.0");
    r.run(["install"]);
    expect(JSON.parse(read(manifest(sb.proj)))).toMatchObject({ tag: "v2026.10.05.1", sha });
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).not.toContain("Правило из main.");
  });

  it("машина копией (-g) — тоже по релизам: main ушёл вперёд — актуально", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const r = withReleases();
    r.release("v2026.10.05");
    expect(r.run(["install", "-g"]).code).toBe(0);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check", "-g"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("на машине: актуально (v2026.10.05)");
    expect(JSON.parse(read(manifest(sb.home))).tag).toBe("v2026.10.05");
  });

  it("релизов ещё нет — ставит голову main, как раньше, без тега", () => {
    const r = withReleases();
    const sha = r.commit(rule(r.up, "Правило из main."));
    expect(r.run(["install"]).code).toBe(0);
    expect(read(path.join(sb.proj, ".agents/ai-dev/AGENTS.md"))).toContain("Правило из main.");
    const m = JSON.parse(read(manifest(sb.proj)));
    expect(m.sha).toBe(sha);
    expect(m.tag).toBeUndefined();
  });

  it("последний релиз не узнать (нет сети) — check: проверка недоступна, код 2; install и update — отказ, код 2; флоу не стоит — релиз не ищет", () => {
    const r = withReleases();
    const offline = { AI_DEV_REPO: path.join(sb.tmp, "nowhere") };
    const absent = r.run(["check"], offline);
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("в проекте: не установлен");
    r.release("v2026.10.05");
    r.run(["install"]);
    const before = snapshot(sb.proj);
    const c = r.run(["check"], offline);
    expect(c.code).toBe(2);
    expect(c.stderr).toContain("в проекте: проверка недоступна — последний релиз ai-dev не узнать");
    for (const cmd of ["install", "update"]) {
      const u = r.run([cmd], offline);
      expect(u.code).toBe(2);
      expect(u.stderr).toContain("последний релиз ai-dev не узнать");
    }
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("хук: последний релиз не узнать — код 0, в выводе — проверка недоступна", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    const h = r.run(["check", "--hook"], { AI_DEV_REPO: path.join(sb.tmp, "nowhere") });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("в проекте: проверка недоступна — последний релиз ai-dev не узнать");
  });
});

describe("Клон --link сверяется с origin/main, update подтягивает его, не трогая работу пользователя", () => {
  const RULE = "\nНовое правило.\n";

  it("клон на origin/main — актуально, код 0", () => {
    linkedClone();
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("актуально");
  });

  it("в main новое правило и новый скилл — отстаёт по скиллу, код 1; правило машину не задевает; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("AGENTS.md");
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
    expect(existsSync(path.join(sb.home, ".agents/ai-dev"))).toBe(false);
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

  /** Напоминание владельцу: без релиза проекты этих правок не получат. Отставанием не считается — код тот же. */
  it("в main после последнего релиза изменения флоу — строка «не в релизе» с тегом, числом и командой релиза; код 0", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    up.repo.commit({ "bin/ai-dev.mjs": read(path.join(up.dir, "bin/ai-dev.mjs")) + "// правка установщика\n" });
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("не в релизе: коммитов флоу после v2026.10.05 — 2");
    expect(r.stdout).toContain(`${path.join(clone, "bin/ai-dev.mjs")} release`);
  });

  it("всё в релизе — строки «не в релизе» нет; релизов ещё нет — так и сказано", () => {
    const { up } = linkedClone();
    expect(aiDev(sb, ["check", "-g"]).stdout).toContain("не в релизе: релизов ещё нет");
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    expect(aiDev(sb, ["check", "-g"]).stdout).not.toContain("не в релизе");
  });

  it("старая установка без SHA — check по git; update -g пишет SHA клона", () => {
    const { up } = linkedClone();
    dropSha(sb.home);
    const sha = up.repo.commit({ "skills/est/new.md": "# Новый справочник скилла\n" });
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ skills/est/new.md");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(sha);
  });

  it("поставлено прошлой версией — симлинк ~/.agents/ai-dev на клон, пути клона в манифесте нет: check находит клон по симлинку, update -g убирает симлинк и пишет путь", () => {
    const { clone } = linkedClone();
    const m = JSON.parse(read(manifest(sb.home)));
    delete m.clone;
    writeFileSync(manifest(sb.home), JSON.stringify(m, null, 2) + "\n");
    symlinkSync(clone, path.join(sb.home, ".agents/ai-dev"));
    const r = aiDev(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`клон ${clone}`);
    expect(r.stdout).toContain("- ~/.agents/ai-dev/");
    expect(aiDev(sb, ["update", "-g"]).code).toBe(0);
    expect(lstatSync(path.join(sb.home, ".agents/ai-dev"), { throwIfNoEntry: false })).toBeUndefined();
    expect(realpathSync(JSON.parse(read(manifest(sb.home))).clone)).toBe(realpathSync(clone));
    expect(aiDev(sb, ["check", "-g"]).code).toBe(0);
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
 * Хук SessionStart ставит `install -g`. Вывод хука с кодом 0 Claude Code добавляет в контекст сессии, с другим — нет,
 * поэтому код хука всегда 0, а ошибка — в выводе.
 */
describe("В начале сессии Claude Code проверка идёт сама и старт сессии не срывает", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude"), { recursive: true }));

  // команда хука из ~/.claude/settings.json — как её запускает Claude Code: через shell, в каталоге проекта
  function runHook() {
    const s = JSON.parse(read(path.join(sb.home, ".claude/settings.json")));
    const hooks: { command: string }[] = s.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    const command = hooks.find((h) => h.command.includes("check --hook"))!.command;
    const r = spawnSync("sh", ["-c", command], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout };
  }

  // npx песочницы отдаёт пакет bin: `npx … github:miroshnik/ai-dev <команда>` → `node <bin> <команда>`
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

  it("в git-репозитории без флоу вывод хука зовёт поставить его в проект; вне git-репозитория строки про проект нет", () => {
    aiDev(sb, ["install", "-g"]);
    npxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-dev в проекте: не установлен — поставь: npx -y github:miroshnik/ai-dev install");
    expect(aiDev(sb, ["check", "--hook"], { cwd: sb.tmp }).stdout).not.toContain("в проекте");
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
