/**
 * Скилл `est`: сколько часов работы агента займёт задача — по фактам похожих закрытых задач, и сколько заняла на
 * самом деле — часы, токены и стоимость из транскриптов.
 *
 * Оценка «из головы» ничем не проверяема, поэтому и оценка, и факт здесь измеряются: факт — по сессиям агента,
 * привязанным к задаче, оценка — по фактам аналогов. Агент выбирает аналоги и объясняет расхождения; скрипт
 * `est.ts` делает детерминированное — читает транскрипты Claude Code, Codex и облачных сессий, ставит поля
 * проекта и пишет комментарии «Оценка» и «Факт».
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import {
  branchHasIssue, branchIssueNumber, branchType, calib, computeFact, EstError, extractKeptLines, factCommentBody,
  cloudPartsIn, cloudSessionsIn, fmtH, hashMatches, sidKey, mergeIntervals, packPr, parseCloudFile, parseCodexFile, parseMarker, parseSessionFile, parseSince, plural, resolveLinks,
  roundScale, usageCost,
} from "../../../skills/est/scripts/est.ts";
import type { CloudPart, FactRepo, PR, Row, Session } from "../../../skills/est/scripts/est.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const EST = fileURLToPath(new URL("../../../skills/est/scripts/est.ts", import.meta.url));
const ts = (hhmm: string) => Date.parse(`2026-09-01T${hhmm}:00Z`) / 1000;
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

function claudeFixture(): string {
  const sid = "11111111-2222-3333-4444-555555555555";
  const top = [
    { type: "custom-title", customTitle: "#42 Биллинг · Экспорт счетов", timestamp: "2026-09-01T10:00:00Z", cwd: "/repo" },
    { type: "user", timestamp: "2026-09-01T10:00:00Z", cwd: "/repo", gitBranch: "feat/42-export", message: { role: "user", content: "#42 сделай экспорт" } },
    {
      type: "assistant", timestamp: "2026-09-01T10:05:00Z", gitBranch: "feat/42-export",
      message: { id: "msg_top_0001", model: "claude-fable-5-1", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 }, content: [{ type: "tool_use", id: "tu1", input: { command: "git commit -m x" } }] },
    },
    { type: "assistant", timestamp: "2026-09-01T10:05:01Z", gitBranch: "feat/42-export", message: { id: "msg_top_0001", model: "claude-fable-5-1", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: "повтор usage того же ответа" }] } },
    { type: "user", timestamp: "2026-09-01T10:06:00Z", gitBranch: "feat/42-export", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "[feat/42-export a1b2c3d] x" }] } },
    { type: "pr-link", timestamp: "2026-09-01T10:10:00Z", prNumber: 77 },
    { type: "user", timestamp: "2026-09-01T10:11:00Z", gitBranch: "feat/42-export", message: { content: "<system-reminder>служебное</system-reminder>" } },
    { type: "user", timestamp: "2026-09-01T10:12:00Z", gitBranch: "feat/42-export", message: { content: "ещё промпт" } },
    { type: "user", timestamp: "2026-09-01T10:13:00Z", gitBranch: "feat/42-export", message: { content: "третий промпт" } },
  ];
  const sub = [
    { type: "user", timestamp: "2026-09-01T10:07:00Z", gitBranch: "feat/42-export", message: { content: "Задача #42: проверь тесты" } },
    { type: "assistant", timestamp: "2026-09-01T10:08:00Z", gitBranch: "feat/42-export", message: { id: "msg_sub_0001", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] } },
  ];
  const file = path.join(dir, sid + ".jsonl");
  writeFileSync(file, jsonl(top));
  mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
  writeFileSync(path.join(dir, sid, "subagents", "agent-1.jsonl"), jsonl(sub));
  return file;
}

type Recorded = Map<number, Record<string, [number, number][]>>;

function stubRepo(sessions: Session[], prs: PR[], closingPr: Record<string, number[]> = {}, recorded: Recorded = new Map()): FactRepo {
  return {
    full: "o/r",
    prs: () => new Map(prs.map((p) => [p.number, p])),
    openPrs: () => ({ at: 0, items: {} }),
    closers: () => ({ oid: {}, pr: closingPr }),
    sessions: () => sessions,
    neutralBranches: () => new Set(["main"]),
    commitDiff: () => null,
    recorded: () => recorded,
  };
}

const pr77 = (): PR => ({
  number: 77, title: "feat: экспорт", state: "MERGED", headRefName: "feat/42-export", baseRefName: "main", body: "Closes #42",
  mergedAt: ts("11:00"), updatedAt: ts("11:00"), additions: 10, deletions: 2, changedFiles: 1, mergeCommit: "ffffffffffffffffffffffffffffffffffffffff",
  closing: [42], commits: [{ oid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", at: ts("10:06") }], commits_total: 1, files: [{ path: "src/a.ts", a: 10, d: 2 }],
});

/**
 * Факт — активные часы: записи, привязанные к задаче, и паузы между ними не длиннее gap (30 мин); общий PR на
 * несколько задач делится поровну.
 */
describe("Факт — активные часы работы над задачей по её сессиям", () => {
  it("записи на ветке задачи и субагента с подсказкой считаются, паузы ≤ gap — время, токены и цена — с долей", () => {
    const s = parseSessionFile(claudeFixture());
    const res = computeFact(stubRepo([s], [pr77()]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    expect(res.h).toBe(0.22); // 10:00 → 10:13 непрерывно
    expect(res.cov).toBe("full");
    expect(res.sessions).toBe(1);
    expect(res.prompts).toBe(3);
    expect(res.details[0]!.rules).toEqual({ ветка: 7, субагент: 2 });
    expect(res.tok).toEqual({ in: 110, out: 55, cw: 1000, cr: 5000, total: 6165 });
    expect(res.usd).toBe(0.02);
    expect(res.diff).toBe(12);
    expect(res.commits).toBe(1);
    expect(res.shared).toEqual([]);
  });

  it("общий PR на две задачи — доля ½ на записях ветки, субагент с подсказкой — целиком; в результате есть «shared»", () => {
    const s = parseSessionFile(claudeFixture());
    const res = computeFact(stubRepo([s], [pr77()], { "77": [43] }), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    // 11 мин ветки × ½ + 2 мин субагента = 0.125 ч; округление как round() в Python — к чётному
    expect(res.h).toBe(0.12);
    expect(res.h_raw).toBe(0.22);
    expect(res.shared).toEqual([{ unit: "PR #77", with: [43], k: 2 }]);
  });

  it("сессия на чужой ветке не привязывается — покрытие none, факт недоступен", () => {
    const foreign: Session = {
      sid: "f", cwd: "/repo", n_human: 3, ev: [[ts("12:00"), "fix/7-login", 1, "", -1], [ts("12:05"), "fix/7-login", 0, "", -1], [ts("12:06"), "fix/7-login", 1, "", -1], [ts("12:07"), "fix/7-login", 1, "", -1]],
      prlinks: [], commits: [], first_refs: [7], first_urls: [], usage: [], models: [], title: "", title_refs: [], title_urls: [], n_subagents: 0, source: "claude", routine: false,
    };
    const pr78: PR = { ...pr77(), number: 78, headRefName: "fix/7-login", closing: [7], commits: [], body: "" };
    const res = computeFact(stubRepo([foreign], [pr77(), pr78]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    expect(res.h).toBeNull();
    expect(res.cov).toBe("none");
    expect(res.tok).toBeNull();
  });

  it("пауза длиннее gap не входит во время", () => {
    const s: Session = {
      sid: "g", cwd: "/repo", n_human: 3, ev: [[ts("10:00"), "feat/42-x", 1, "", -1], [ts("10:10"), "feat/42-x", 0, "", -1], [ts("12:00"), "feat/42-x", 1, "", -1], [ts("12:05"), "feat/42-x", 0, "", -1]],
      prlinks: [], commits: [], first_refs: [42], first_urls: [], usage: [], models: [], title: "", title_refs: [], title_urls: [], n_subagents: 0, source: "claude", routine: false,
    };
    const res = computeFact(stubRepo([s], []), 42, [], [], 30);
    expect(res.h).toBe(0.25); // 10 + 5 минут, без двух часов паузы
    expect(res.wall).toBe(2.1);
  });
});

/**
 * Одна сессия может вести несколько задач подряд: её переименовывают под каждую следующую. Записи на ветке без
 * номера задачи (её назвал инструмент worktree) достаются задаче из названия сессии на момент записи: первое
 * название действует с начала сессии, каждое следующее — с переименования. Одна запись — одной задаче.
 */
describe("Сессия, которая ведёт задачи подряд, делит время между ними", () => {
  const SID = "33333333-4444-5555-6666-777777777777";
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00Z`;
  const work = (hhmm: string, gitBranch: string) => ({ type: "assistant", timestamp: at(hhmm), cwd: "/repo", gitBranch, message: { content: [{ type: "text", text: "…" }] } });
  const prompt = (hhmm: string, gitBranch: string, text: string) => ({ type: "user", timestamp: at(hhmm), cwd: "/repo", gitBranch, origin: { kind: "human" }, message: { role: "user", content: text } });
  // так пишет переименование Claude Code: без времени — оно берётся у следующей записи
  const rename = (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: SID });
  const prLink = (hhmm: string, prNumber: number) => ({ type: "pr-link", timestamp: at(hhmm), prNumber });
  const WT = "claude/festive-kilby-1a2b3c"; // ветка worktree без номера задачи

  function session(): Session {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl([
      rename("#41 Экспорт"),
      prompt("10:00", WT, "сделай #41, потом #42 и #43"), work("10:06", WT), work("10:12", WT),
      rename("#42 Импорт"),
      prompt("10:18", WT, "теперь импорт"), work("10:24", WT),
      work("10:30", "fix/41-export"), work("10:33", "fix/41-export"), prLink("10:36", 101),
      work("10:36", "fix/42-import"), work("10:42", "fix/42-import"), prLink("10:48", 102), work("10:48", "fix/42-import"),
      rename("#43 Отчёт"),
      prompt("10:54", "fix/43-report", "теперь отчёт"), work("11:00", "fix/43-report"), prLink("11:06", 103), work("11:06", "fix/43-report"),
    ]));
    return parseSessionFile(file);
  }
  const pr = (number: number, headRefName: string, issue: number): PR => ({ ...pr77(), number, headRefName, closing: [issue], commits: [], body: `Closes #${issue}` });
  const prs = [pr(101, "fix/41-export", 41), pr(102, "fix/42-import", 42), pr(103, "fix/43-report", 43)];
  const fact = (s: Session, n: number, recorded?: Recorded) => computeFact(stubRepo([s], prs, {}, recorded), n, [{ ...prs.find((p) => p.closing[0] === n)!, why: "закрыл issue" }], []);

  it("записи безномерной ветки достаются задаче из названия на момент записи, а не из последнего; ни одна не засчитана двум задачам", () => {
    const s = session();
    const [f41, f42, f43] = [fact(s, 41), fact(s, 42), fact(s, 43)] as const;
    expect(f41.h).toBe(0.25); // 10:00–10:12 на ветке worktree под «#41» + 10:30–10:33 на своей ветке
    expect(f41.details[0]!.rules).toEqual({ название: 3, ветка: 2 });
    expect(f42.h).toBe(0.3); // 10:18–10:24 на ветке worktree под «#42» + 10:36–10:48 на своей ветке
    expect(f42.details[0]!.rules).toEqual({ название: 2, ветка: 3 });
    expect(f43.h).toBe(0.2); // только своя ветка: под «#43» на ветке worktree уже не работали
    expect(f43.details[0]!.rules).toEqual({ ветка: 3 });
    const all = [f41, f42, f43].flatMap((f) => f.intervals);
    const len = (iv: [number, number][]) => iv.reduce((a, [x, y]) => a + y - x, 0);
    expect(len(mergeIntervals(all))).toBe(len(all));
  });

  // Claude Code повторяет pr-link привязанного к сессии PR и после мержа — это статус приложения, не работа над PR
  it("pr-link смёрженного PR прошлой задачи, повторённый после мержа, не обрывает время следующей задачи", () => {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl([
      rename("#41 Экспорт"),
      prompt("10:00", "fix/41-export", "сделай #41"), work("10:06", "fix/41-export"), prLink("10:10", 101), work("10:12", "fix/41-export"),
      rename("#44 Исследование"),
      prompt("10:18", "HEAD", "теперь #44"), prLink("10:20", 101), work("10:24", "HEAD"), prLink("10:26", 101), work("10:30", "HEAD"),
    ]));
    const merged = { ...prs[0]!, mergedAt: ts("10:14") };
    const f44 = computeFact(stubRepo([parseSessionFile(file)], [merged]), 44, [], []);
    expect(f44.h).toBe(0.2); // 10:18–10:30 под «#44»
    expect(f44.details[0]!.rules).toEqual({ название: 3 }); // промпт и две записи работы; pr-link — не запись работы
  });

  it("окно своего PR не тянется назад через переименование: записи на HEAD под прошлым названием остаются прошлой задаче", () => {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl([
      rename("#41 Экспорт"),
      prompt("10:00", "HEAD", "сделай #41"), work("10:06", "HEAD"), work("10:12", "HEAD"),
      rename("#45 Отчёт"),
      prompt("10:18", "HEAD", "теперь #45"), work("10:24", "fix/45-report"), prLink("10:30", 105), work("10:30", "fix/45-report"),
    ]));
    const p105 = pr(105, "fix/45-report", 45);
    const f45 = computeFact(stubRepo([parseSessionFile(file)], [p105]), 45, [{ ...p105, why: "закрыл issue" }], []);
    expect(f45.h).toBe(0.2); // 10:18–10:30; 10:00–10:12 — время #41
  });

  it("маркер факта хранит интервалы по сессиям — по ним следующий расчёт видит, что уже засчитано", () => {
    const body = factCommentBody(fact(session(), 42), null, [], 0, null);
    expect(parseMarker(body, "fact").iv).toEqual({ "33333333": [[ts("10:18"), ts("10:24")], [ts("10:36"), ts("10:48")]] });
  });

  it("запись, уже засчитанная в записанном факте другой задачи той же сессии, по названию повторно не засчитывается — комментарий называет ту задачу", () => {
    // факт #42 записан до исправления и забрал записи 10:00–10:12, сделанные под «#41»
    const recorded: Recorded = new Map([[42, { "33333333": [[ts("10:00"), ts("10:12")]] }]]);
    const f41 = fact(session(), 41, recorded);
    expect(f41.h).toBe(0.05); // осталась своя ветка, 10:30–10:33
    expect(f41.taken).toEqual([{ issue: 42, h: 0.2 }]);
    expect(factCommentBody(f41, null, [], 0, null)).toContain("Не засчитано повторно: 0.2 ч уже в факте #42.");
  });

  it("повтор той же записи названия не начинает новый период — переход на другую ветку без номера по-прежнему закрывает окно", () => {
    // Claude Code повторяет запись custom-title по ходу сессии, не только при переименовании
    const file = path.join(dir, SID + ".jsonl");
    const OTHER = "claude/brave-noether-9z8y7x";
    writeFileSync(file, jsonl([
      rename("#41 Экспорт"),
      prompt("10:00", WT, "сделай #41"), work("10:06", WT), rename("#41 Экспорт"), work("10:12", WT),
      work("10:18", OTHER), rename("#41 Экспорт"), work("10:24", OTHER), work("10:30", OTHER),
    ]));
    const f41 = fact(parseSessionFile(file), 41);
    expect(f41.h).toBe(0.3); // 10:00–10:18: окно закрыла первая запись на другой ветке
  });

  it("запись на своей ветке остаётся своей и при пересечении с записанным фактом другой задачи — только предупреждение", () => {
    const recorded: Recorded = new Map([[43, { "33333333": [[ts("10:30"), ts("10:33")]] }]]);
    const f41 = fact(session(), 41, recorded);
    expect(f41.h).toBe(0.25);
    expect(f41.overlap).toEqual([{ issue: 43, h: 0.05 }]);
    expect(factCommentBody(f41, null, [], 0, null)).toContain("Пересечение с фактом #43: 0.05 ч — пересчитать #43.");
  });
});

/**
 * PR задачи: сильные связи (закрыл, `Closes #N`, номер в ветке, связан вручную) и — только если сильных нет —
 * слабые, упоминания. Упоминание в PR, который закрывает другие задачи, — не работа над этой: иначе задача без
 * своего PR получает чужой PR, его время и тип.
 */
describe("PR достаётся задаче, которую он делает, а не той, что упомянута", () => {
  const pr = (number: number, closing: number[], body: string, headRefName = "feat/1-x"): PR => ({ ...pr77(), number, closing, body, headRefName });
  const repo = (prs: PR[]) => ({ full: "o/r", owner: "o", name: "r", prs: () => new Map(prs.map((p) => [p.number, p])), pr: (n: number) => prs.find((p) => p.number === n) ?? null });
  const issue = (number: number, refs: number[] = []) => ({
    number,
    closedByPullRequestsReferences: { nodes: [] },
    timelineItems: { nodes: refs.map((n) => ({ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", number: n } })) },
  });

  it("PR закрывает другую задачу и лишь упоминает эту — к ней не привязывается", () => {
    const [prs, , weak] = resolveLinks(repo([pr(51, [47], "Closes #47\n\nсоздана #50")]), issue(50, [51]));
    expect(prs.map((p) => p.number)).toEqual([]);
    expect(weak).toBe(false);
  });

  it("PR без закрываемых задач, упоминающий задачу, — слабая связь, когда сильных нет", () => {
    const [prs, , weak] = resolveLinks(repo([pr(60, [], "продолжение #50")]), issue(50, [60]));
    expect(prs.map((p) => [p.number, p.why])).toEqual([[60, "упоминание"]]);
    expect(weak).toBe(true);
  });

  it("сильная связь — Closes #N или номер в ветке — важнее упоминаний", () => {
    const [prs, , weak] = resolveLinks(repo([pr(61, [], "Closes #50"), pr(62, [], "см. #50"), pr(63, [], "", "fix/50-x")]), issue(50, [62]));
    expect(prs.map((p) => [p.number, p.why])).toEqual([[61, "Closes #50 в теле PR"], [63, "номер в ветке"]]);
    expect(weak).toBe(false);
  });
});

/** Номер привязывает работу к задаче, тип нужен истории оценок — аналоги ищутся среди задач того же типа. */
describe("Ветка `<type>/<issue>-<slug>` даёт номер и тип задачи", () => {
  it("номер — отдельный токен ветки, даты и однозначные числа без issue- не считаются", () => {
    expect(branchHasIssue("feat/42-invoice-export", 42)).toBe(true);
    expect(branchHasIssue("issue-7-login", 7)).toBe(true);
    expect(branchHasIssue("release/2026-09-16", 9)).toBe(false);
    expect(branchHasIssue("fix/7-login", 7)).toBe(false);
    expect(branchHasIssue("feat/420-x", 42)).toBe(false);
  });

  it("конвенция <type>/N-slug даёт номер и тип, префикс области допустим", () => {
    expect(branchIssueNumber("backend/fix/263-login-loop")).toBe(263);
    expect(branchType("backend/fix/263-login-loop")).toBe("fix");
    expect(branchIssueNumber("issues/15")).toBe(15);
    expect(branchIssueNumber("release/2026-09")).toBeNull();
    expect(branchType("claude/interesting-kilby-df89ea")).toBeNull();
  });
});

/**
 * Из транскрипта берутся привязки к задаче — название сессии, промпты, ветка, хеши коммитов, PR — и расход
 * токенов.
 */
describe("Транскрипт Claude Code даёт привязки к задаче и расход токенов", () => {
  it("название сессии, первый промпт, промпты, хеши из вывода инструментов, pr-link, usage раз на ответ, подсказка субагента", () => {
    const s = parseSessionFile(claudeFixture());
    expect(s.source).toBe("claude");
    expect(s.title_refs).toEqual([42]);
    expect(s.first_refs).toEqual([42]);
    expect(s.n_human).toBe(3); // служебная вставка и промпт субагента — не человек
    expect(s.prlinks).toEqual([[ts("10:10"), 77]]);
    expect(s.commits.map((c) => c[1])).toEqual(["a1b2c3d"]);
    expect(s.models).toEqual(["claude-fable-5-1", "claude-haiku-4-5-20251001"]);
    expect(s.usage).toHaveLength(2);
    expect(s.usage[0]).toEqual(["msg_top_0001", 0, 100, 50, 1000, 0, 5000, 0]);
    expect(s.ev.filter((e) => e[3] === "42")).toHaveLength(2);
    expect(s.n_subagents).toBe(1);
    expect(s.routine).toBe(false);
  });

  it("вставки <system-reminder> перед текстом промпта вырезаются: промпт человеческий, номер задачи — из текста, а не из вставки; одна вставка — не промпт", () => {
    // так пишет Claude Code desktop (Code tab): картинка, затем текст, начинающийся со вставки приложения
    const reminder = (s: string) => `<system-reminder>\n${s}\n</system-reminder>`;
    const file = path.join(dir, "code-tab.jsonl");
    writeFileSync(file, jsonl([
      {
        type: "user", timestamp: "2026-09-01T10:00:00Z", cwd: "/repo", gitBranch: "main", origin: { kind: "human" },
        message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "" } }, { type: "text", text: `${reminder("git status: Merge pull request #31")}\n${reminder("worktree")}\n#42 сделай экспорт` }] },
      },
      { type: "user", timestamp: "2026-09-01T10:01:00Z", gitBranch: "main", message: { content: [{ type: "text", text: reminder("только вставка") }] } },
      { type: "user", timestamp: "2026-09-01T10:02:00Z", gitBranch: "main", origin: { kind: "human" }, message: { content: "ещё промпт" } },
    ]));
    const s = parseSessionFile(file);
    expect(s.n_human).toBe(2);
    expect(s.first_refs).toEqual([42]);
  });
});

/** У записей Codex нет ветки — привязка к задаче только по номеру в промпте и хешам коммитов. */
describe("Транскрипт Codex — такой же источник факта, только без ветки", () => {
  it("cwd и id из session_meta, промпт из UserMessage, токены раз на response_id, хеши из выводов инструментов", () => {
    const file = path.join(dir, "rollout-1.jsonl");
    writeFileSync(file, jsonl([
      { type: "session_meta", payload: { cwd: "/repo", id: "codex-1" } },
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      { type: "event_msg", timestamp: "2026-09-01T10:00:00Z", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "#42 экспорт" }] } } },
      { type: "response_item", timestamp: "2026-09-01T10:01:00Z", payload: { type: "function_call", call_id: "c1", arguments: "{\"cmd\":\"git commit -m x\"}" } },
      { type: "response_item", timestamp: "2026-09-01T10:02:00Z", payload: { type: "function_call_output", call_id: "c1", output: "[main deadbeef1] x" } },
      { type: "token_usage_record", timestamp: "2026-09-01T10:03:00Z", payload: { response_id: "resp_1", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 20 } } },
      { type: "token_usage_record", timestamp: "2026-09-01T10:03:01Z", payload: { response_id: "resp_1", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 20 } } },
    ]));
    const s = parseCodexFile(file);
    expect(s.source).toBe("codex");
    expect(s.sid).toBe("codex-1");
    expect(s.cwd).toBe("/repo");
    expect(s.first_refs).toEqual([42]);
    expect(s.commits.map((c) => c[1])).toEqual(["deadbeef1"]);
    expect(s.usage).toEqual([["resp_1", 0, 600, 20, 0, 0, 400, 0]]);
    expect(s.models).toEqual(["gpt-5-codex"]);
  });
});

/**
 * Облачная сессия Claude Code (claude.ai/code): её транскрипт — события сессии, выгруженные из claude.ai браузером
 * (`est cloud-import`). Это ещё один источник факта, как Codex: те же записи, ветки, промпты, токены и хеши, только
 * ветка приходит событием `vcs_state_changed`, а человек — это `source: client`. Коммит PR с трейлером
 * `Claude-Session`, чья сессия не импортирована, — покрытие partial со ссылкой на сессию: часть работы не видна.
 */
describe("Облачная сессия считается по событиям, выгруженным из claude.ai", () => {
  const SESSION = "session_01CloudTest";
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00.000Z`;
  let seq = 0;
  const event = (hhmm: string, event_type: string, payload: object, source = "worker") => ({ created_at: at(hhmm), event_id: `e${++seq}`, event_type, payload, sequence_num: String(seq), source });
  const usage = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } };
  const assistant = (hhmm: string, id: string, parent: string | null = null) =>
    event(hhmm, "assistant", { type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "…" }], usage }, parent_tool_use_id: parent, timestamp: at(hhmm) });
  const prompt = (hhmm: string, text: string, parent: string | null = null) => event(hhmm, "user", { type: "user", message: { role: "user", content: text }, parent_tool_use_id: parent }, parent ? "worker" : "client");
  const toolResult = (hhmm: string, text: string, parent: string | null = null) =>
    event(hhmm, "user", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] }, parent_tool_use_id: parent, timestamp: at(hhmm) });
  const vcs = (hhmm: string, branch: string) => event(hhmm, "system", { type: "system", subtype: "vcs_state_changed", kind: "commit", branch, cwd: "/home/user/r" });
  const OID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const events = () => [
    event("10:00", "system", { type: "system", subtype: "init", cwd: "/home/user/r" }),
    prompt("10:00", "сделай #42"),
    // вставка от облака (текст скилла) — не человек, хоть и сообщение user верхнего уровня
    event("10:01", "user", { type: "user", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: … #7" }] }, parent_tool_use_id: null }),
    assistant("10:02", "msg_01AAAAAAAAAAAA"), assistant("10:02", "msg_01AAAAAAAAAAAA"), // тот же ответ дважды
    toolResult("10:04", "[fix/42-export a1b2c3d] fix: экспорт"), vcs("10:04", "fix/42-export"),
    assistant("10:06", "msg_01BBBBBBBBBBBB"),
    prompt("10:07", "проверь #42 экспорт", "toolu_sub"), assistant("10:08", "msg_01CCCCCCCCCCCC", "toolu_sub"),
    // переход на другую ветку облако событием не сообщает — его видно в выводе git
    toolResult("10:09", "Switched to a new branch 'feat/43-report'"), assistant("10:10", "msg_01DDDDDDDDDDDD"),
  ];
  // выгрузка — как её сохраняет браузер: события новые сверху, как отдаёт API
  const exportFile = (evs: object[]) => {
    const f = path.join(dir, `${SESSION}.json`);
    writeFileSync(f, JSON.stringify({ v: 1, session: SESSION, repo: "o/r", title: "Экспорт", branch: "fix/42-export", events: [...evs].reverse() }));
    return f;
  };
  const cloudPr = (): PR => ({ ...pr77(), commits: [{ oid: OID, at: ts("10:04") }], cloud: [SESSION] });

  it("события → сессия: человек — клиент, ветка — из vcs_state_changed и вывода git (до них нейтральная), токены раз на ответ, хеши из выводов, субагент — в таймлайне", () => {
    const s = parseCloudFile(exportFile(events()));
    expect(s).toMatchObject({ sid: SESSION, source: "cloud", cwd: "/home/user/r", n_human: 1, first_refs: [42], commits: [[ts("10:04"), "a1b2c3d"]] });
    expect(s.usage.map((u) => [u[0], u[5]])).toEqual([["AAAAAAAAAAAA", 500], ["BBBBBBBBBBBB", 500], ["DDDDDDDDDDDD", 500], ["CCCCCCCCCCCC", 500]]);
    expect(s.ev.map((e) => [e[0], e[1]])).toEqual([
      [ts("10:00"), ""], [ts("10:01"), ""], [ts("10:02"), ""], [ts("10:02"), ""], [ts("10:04"), ""], [ts("10:06"), "fix/42-export"], [ts("10:07"), "fix/42-export"], [ts("10:08"), "fix/42-export"],
      [ts("10:09"), "fix/42-export"], [ts("10:10"), "feat/43-report"],
    ]);
    expect(s.ev.filter((e) => e[3]).map((e) => e[3])).toEqual(["42", "42"]); // задание субагента называет задачу
  });

  it("облачная сессия считается в факт наравне с локальной — покрытие full, агент назван", () => {
    const s = parseCloudFile(exportFile(events()));
    const res = computeFact(stubRepo([s], [cloudPr()]), 42, [{ ...cloudPr(), why: "закрыл issue" }], []);
    expect(res.h).toBe(0.15); // 10:00–10:09: задача названа в первом промпте; с 10:10 — чужая ветка
    expect(res.cov).toBe("full");
    expect(res.cloud_missing).toEqual([]);
    expect(factCommentBody(res, 1, [], 0, null)).toContain("активных в облачной сессии Claude Code");
  });

  it("коммит PR с трейлером Claude-Session, чья сессия не импортирована, — покрытие partial и ссылка на сессию", () => {
    const local = parseCloudFile(exportFile(events()));
    local.sid = "local-session"; // та же работа, но как будто локальная — а облачной части нет
    local.source = "claude";
    const res = computeFact(stubRepo([local], [cloudPr()]), 42, [{ ...cloudPr(), why: "закрыл issue" }], []);
    expect(res.cov).toBe("partial");
    expect(res.cloud_missing).toEqual([SESSION]);
    expect(factCommentBody(res, 1, [], 0, null)).toContain(`Облачная сессия https://claude.ai/code/${SESSION} не импортирована — est cloud-import.`);
  });

  // ключ сессии в маркере «Факт» (iv) — 8 знаков; у облачных сессий общий префикс session_ их бы склеил
  it("ключ облачной сессии в маркере — после префикса session_, локальной — как был", () => {
    expect(sidKey("session_01EyZM6zcMGdi6EB671Vgzy9")).toBe("01EyZM6z");
    expect(sidKey("session_01HXRv6nrTK3GBKj38JJ9MLZ")).toBe("01HXRv6n");
    expect(sidKey("5832ef9f-1111-2222-3333-444444444444")).toBe("5832ef9f");
  });

  it("трейлер Claude-Session читается из тела коммита PR", () => {
    expect(cloudSessionsIn("fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Abc\n")).toEqual(["session_01Abc"]);
    expect(cloudSessionsIn("fix: без трейлера")).toEqual([]);
    const pr = packPr({ number: 7, commits: { totalCount: 2, nodes: [
      { commit: { oid: "a".repeat(40), authoredDate: at("10:00"), messageBody: "Claude-Session: https://claude.ai/code/session_01Abc" } },
      { commit: { oid: "b".repeat(40), authoredDate: at("10:05"), messageBody: "" } },
    ] } });
    expect(pr.cloud).toEqual(["session_01Abc"]);
  });

  /**
   * Облачная сессия считает свою часть сама — по своему транскрипту в контейнере — и отдаёт её в комментарии «Факт
   * (облако)» маркером `cloud`. Поля проекта из облака не поставить: их ставит локальный `est fact --write` / `--sweep`,
   * складывая облачную часть с локальной. Выгрузка той же сессии, если импортирована, важнее части.
   */
  describe("облачная часть в маркере факта", () => {
    const part: CloudPart = {
      session: SESSION, h: 0.2, iv: [[ts("10:00"), ts("10:12")]], prompts: 1,
      tok: { in: 1, out: 1000, cw: 0, cr: 100000, total: 101001 }, models: { "claude-opus-5-5": { mtok: 0.1, usd: 0.08 } },
    };
    const fact = (sessions: Session[], parts: CloudPart[]) => computeFact(stubRepo(sessions, [cloudPr()]), 42, [{ ...cloudPr(), why: "закрыл issue" }], [], 30, parts);

    it("облачная часть считается, как сессия: время, токены, стоимость, покрытие full по трейлеру; в маркере — сохраняется", () => {
      const res = fact([], [part]);
      expect(res).toMatchObject({ h: 0.2, cov: "full", sessions: 1, prompts: 1, cloud_missing: [], usd: 0.08 });
      expect(res.tok.total).toBe(101001);
      expect(parseMarker(factCommentBody(res, 1, [], 0, null), "fact").cloud).toEqual([part]);
    });

    it("с локальной работой той же поры — сумма без двойного счёта пересечения", () => {
      const local = parseCloudFile(exportFile(events()));
      local.sid = "local-session";
      local.source = "claude";
      expect(fact([local], [part]).h).toBe(0.2); // 10:00–10:09 локально и 10:00–10:12 в облаке — это 10:00–10:12
    });

    it("выгрузка той же сессии импортирована — часть из маркера второй раз не считается", () => {
      const res = fact([parseCloudFile(exportFile(events()))], [part]);
      expect(res.h).toBe(0.15);
      expect(res.sessions).toBe(1);
    });

    it("части собираются из всех комментариев с маркером факта; по сессии — последняя", () => {
      const body = (p: CloudPart) => `Факт (облако): …\n<!-- fact ${JSON.stringify({ v: 1, h: p.h, src: "cloud", cloud: [p] })} -->`;
      const later = { ...part, h: 0.3 };
      const other = { ...part, session: "session_01Other" };
      expect(cloudPartsIn([body(part), "просто комментарий", body(other), body(later)])).toEqual([later, other]);
    });
  });

  it("est cloud-import кладёт выгрузку в личный каталог по репозиторию; не выгрузка — ошибка", () => {
    const env = { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "" };
    const r = spawnSync("bun", [EST, "cloud-import", exportFile(events())], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    const stored = path.join(dir, "ai-dev", "cloud", "o", "r", `${SESSION}.json`);
    expect(JSON.parse(readFileSync(stored, "utf8")).session).toBe(SESSION);
    expect(r.stdout).toContain(`${SESSION} (o/r, «Экспорт»): 12 событий, 1 промпт, 10:00–10:10 UTC → ${stored}`);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ data: [] }));
    const bad = spawnSync("bun", [EST, "cloud-import", path.join(dir, "bad.json")], { encoding: "utf8", env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("не выгрузка облачной сессии");
  });
});

/**
 * В облачной сессии Claude Code (claude.ai/code) GitHub доступен только через REST своего репозитория: GraphQL и
 * проекты закрыты. Факт своей сессии est считает по транскрипту в контейнере и печатает готовый комментарий —
 * агент записывает его инструментом GitHub, поля проекта ставит ближайшая локальная сессия.
 */
describe("В облачной сессии est считает свою часть факта, остальное — ошибка с объяснением", () => {
  const cloud = (...args: string[]) =>
    spawnSync("bun", [EST, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Test" } });

  it("est fact печатает комментарий «Факт недоступен (облако)» со ссылкой на сессию и маркером факта — в GitHub не ходит", () => {
    const r = cloud("fact", "42");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Факт недоступен (облако): ");
    expect(r.stdout).toContain("Сессия: https://claude.ai/code/session_01Test.");
    expect(parseMarker(r.stdout, "fact")).toMatchObject({ h: null, cov: "none", src: "cloud", session: "session_01Test" });
  });

  it("est fact в облаке считает часть сессии по её транскрипту в контейнере: «Факт (облако)» с цифрами и маркером части", () => {
    const cwd = path.join(dir, "repo");
    mkdirSync(cwd);
    const proj = path.join(dir, ".claude", "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(proj, { recursive: true });
    const usage = { input_tokens: 1, output_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 };
    const rec = (hhmm: string, extra: object) => ({ timestamp: `2026-09-01T${hhmm}:00Z`, cwd, gitBranch: "claude/export-x", ...extra });
    writeFileSync(path.join(proj, "11111111-2222-3333-4444-555555555555.jsonl"), jsonl([
      rec("10:00", { type: "user", origin: { kind: "human" }, message: { role: "user", content: "#42 сделай экспорт" } }),
      rec("10:06", { type: "assistant", message: { id: "msg_01", model: "claude-opus-5-5", content: [{ type: "text", text: "…" }], usage } }),
      rec("10:12", { type: "assistant", message: { id: "msg_02", model: "claude-opus-5-5", content: [{ type: "text", text: "…" }], usage } }),
    ]));
    const r = spawnSync("bun", [EST, "fact", "42"], { cwd, encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Test" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Факт (облако): 0.2 ч активных в облачной сессии Claude Code, 1 промпт.");
    expect(r.stdout).toContain("Сессия: https://claude.ai/code/session_01Test. Поля проекта поставит локальная сессия: est fact 42 --write.");
    const m = parseMarker(r.stdout, "fact");
    expect(m).toMatchObject({ h: 0.2, src: "cloud", session: "session_01Test" });
    expect(m.cloud).toMatchObject([{ session: "session_01Test", h: 0.2, iv: [[ts("10:00"), ts("10:12")]], prompts: 1, tok: { total: 202002 } }]);
  });

  it("оценка, история и sweep в облаке — ошибка с объяснением, а не сбой gh", () => {
    for (const args of [["estimate", "42", "--type", "feat", "--hours", "1"], ["history"], ["fact", "--sweep"]]) {
      const r = cloud(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("облачная сессия");
    }
  });
});

/**
 * Комментарии «Оценка» и «Факт» кончаются машинным маркером `<!-- est {…} -->` или `<!-- fact {…} -->`: по
 * нему скрипт находит свой комментарий и обновляет его, а не пишет новый. Строки, дописанные человеком,
 * переживают перезапись.
 */
describe("Комментарии «Оценка» и «Факт» обновляются на месте, строки человека сохраняются", () => {
  it("маркер <!-- est {…} --> читается, битый JSON — как отсутствие", () => {
    expect(parseMarker('Оценка: 1 ч\n<!-- est {"v": 2, "h": 1} -->', "est")).toEqual({ v: 2, h: 1 });
    expect(parseMarker("<!-- est {v: 2} -->", "est")).toBeNull();
    expect(parseMarker('<!-- fact {"h": 1} -->', "est")).toBeNull();
  });

  it("«+ вручную: N ч» и «Причина: …» сохраняются при перезаписи комментария", () => {
    const [manual, cause, lines] = extractKeptLines("Факт: 1 ч.\n+ вручную: 1,5 ч\nПричина: вырос объём: две подсистемы\n<!-- fact {} -->");
    expect(manual).toBe(1.5);
    expect(cause).toBe("вырос объём: две подсистемы");
    expect(lines).toEqual(["+ вручную: 1,5 ч", "Причина: вырос объём: две подсистемы"]);
  });

  it("текст с часами, отношением к оценке, PR и диффом; маркер разбирается обратно; строки человека сохранены", () => {
    const s = parseSessionFile(claudeFixture());
    const res = computeFact(stubRepo([s], [pr77()]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    res.type = "feat";
    const body = factCommentBody(res, 1, ["+ вручную: 1 ч"], 1, null);
    expect(body).toContain("Факт: 0.22 ч активных в Claude Code (оценка 1 ч, ×0.22). 1 сессия, 3 промпта, стена 0.2 ч, покрытие full. PR #77; 1 коммит, дифф 12 строк.");
    // разбивка по моделям в скобках — только когда ценой обладают две и больше; у haiku здесь $0.00
    expect(body).toContain("Токены: 0.01 млн (вход 0 · выход 0 · запись кэша 0 · чтение кэша 0.01); стоимость по API-тарифам ≈ $0.02.\n");
    expect(body).toContain("\n+ вручную: 1 ч\n");
    const marker = parseMarker(body, "fact");
    expect(marker.h).toBe(0.22);
    expect(marker.manual).toBe(1);
    expect(marker.type).toBe("feat");
    expect(marker.prs).toEqual([77]);
  });

  it("без сессий — «Факт недоступен» и покрытие none в маркере", () => {
    const res = computeFact(stubRepo([], [pr77()]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    const body = factCommentBody(res, null, [], 0, null);
    expect(body.startsWith("Факт недоступен: сессии не найдены (покрытие none). PR #77;")).toBe(true);
    expect(parseMarker(body, "fact").cov).toBe("none");
  });
});

/** На подписке эти деньги не списываются, но стоимость сравнима между задачами и моделями. */
describe("Стоимость — API-эквивалент по публичным тарифам", () => {
  const table = { "claude-fable-5-1": [10, 50, 0.25] as [number, number, number] };

  it("вход, выход, запись кэша ×1.25 (5 мин) и ×2 (1 ч), чтение кэша — по тарифу модели", () => {
    expect(usageCost("claude-fable-5-1-20260101", [1e6, 0, 0, 0, 0], false, table)).toBe(10);
    expect(usageCost("claude-fable-5-1", [0, 1e6, 0, 0, 0], false, table)).toBe(50);
    expect(usageCost("claude-fable-5-1", [0, 0, 1e6, 0, 0], false, table)).toBe(12.5);
    expect(usageCost("claude-fable-5-1", [0, 0, 0, 1e6, 0], false, table)).toBe(20);
    expect(usageCost("claude-fable-5-1", [0, 0, 0, 0, 1e6], false, table)).toBe(0.25);
  });

  it("модель вне прайса — без цены (null), а не ноль", () => {
    expect(usageCost("gpt-5", [1e6, 0, 0, 0, 0], false, table)).toBeNull();
  });
});

/** Ступени 0,1 · 0,25 · 0,5 · 1 · 1,5 · 2 · 3 · 5 · 8 · 13 ч: точнее по аналогам не угадать, а больше 13 ч — задачу надо дробить. */
describe("Оценка — ступень шкалы от 0,1 до 13 ч", () => {
  it("округляет к ближайшей ступени, при равном расстоянии — к меньшей, выше 13 не бывает", () => {
    expect(roundScale(2.6)).toBe(3);
    expect(roundScale(0.175)).toBe(0.1);
    expect(roundScale(0.4)).toBe(0.5);
    expect(roundScale(20)).toBe(13);
  });
});

/** k — отношение факт/оценка по истории; справочное — к прогнозу по аналогам не применяется. */
describe("Калибровка k показывает, сходятся ли оценки с фактами", () => {
  const row = (n: number, est: number, fact: number | null, cov = "full", closedAt = 1000 + n): Row => ({
    item_id: "i", issue_id: "x", number: n, title: "t", state: "CLOSED", stateReason: null, closedAt, createdAt: null, labels: [],
    est, fact, status: null, est_marker: { h: est }, fact_marker: fact === null ? null : { cov },
  });

  it("k — медиана факт/оценка по задачам с маркером и полным покрытием; partial не в счёт", () => {
    const c = calib([row(1, 1, 0.5), row(2, 2, 4), row(3, 1, 1), row(4, 1, 9, "partial"), row(5, 1, null)]);
    expect(c.n).toBe(3);
    expect(c.k).toBe(1);
    expect(c.share).toBe(1);
    expect(c.n_partial).toBe(1);
  });
});

/** Время — объединение интервалов активности; хеш коммита в выводе инструментов бывает коротким или полным. */
describe("Время — без двойного счёта, коммит узнаётся и по короткому хешу", () => {
  it("пересекающиеся интервалы сливаются, короткий хеш — префикс полного", () => {
    expect(mergeIntervals([[10, 20], [15, 30], [40, 50], [5, 8]])).toEqual([[5, 8], [10, 30], [40, 50]]);
    expect(hashMatches("a1b2c3d", ["a1b2c3d4e5f6"])).toBe(true);
    expect(hashMatches("a1b2c3d4e5f6", ["a1b2c3d"])).toBe(true);
    expect(hashMatches("ffffff1", ["a1b2c3d"])).toBe(false);
  });
});

describe("Вывод читается человеком: часы без хвостовых нулей, склонения, периоды", () => {
  it("часы без хвостовых нулей, отсутствие — тире, склонение по числу", () => {
    expect(fmtH(2.5)).toBe("2.5");
    expect(fmtH(2)).toBe("2");
    expect(fmtH(0.004)).toBe("0");
    expect(fmtH(null)).toBe("—");
    expect(fmtH(33, 1)).toBe("33");
    expect([1, 2, 5, 11, 21].map((n) => plural(n, "сессия", "сессии", "сессий"))).toEqual(["сессия", "сессии", "сессий", "сессий", "сессия"]);
  });

  it("период --since: дни, недели, месяцы, часы; иное — ошибка", () => {
    expect(parseSince("90d")).toBe(90 * 86400);
    expect(parseSince("12w")).toBe(12 * 7 * 86400);
    expect(parseSince("6m")).toBe(6 * 30 * 86400);
    expect(parseSince("48h")).toBe(48 * 3600);
    expect(() => parseSince("вчера")).toThrow(EstError);
  });
});

describe("Неверный вызов — справка или ошибка до обращения к GitHub", () => {
  const run = (...args: string[]) => spawnSync("bun", [EST, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "" } });

  it("без команды — справка и код 2, неизвестная команда — ошибка", () => {
    expect(run().status).toBe(2);
    expect(run().stdout).toContain("est history");
    const r = run("frobnicate");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ошибка: неизвестная команда «frobnicate»");
  });

  it("проверки аргументов — до обращения к GitHub", () => {
    expect(run("fact", "1", "--repo", "o/r", "--gap", "0").stderr).toContain("--gap должен быть ≥ 1 минуты");
    expect(run("fact", "1", "--sweep", "--repo", "o/r").stderr).toContain("номер issue и --sweep несовместимы");
    expect(run("estimate", "1", "--repo", "o/r").stderr).toContain("--type обязателен");
    expect(run("estimate", "--repo", "o/r", "--type", "feat").stderr).toContain("укажите номер issue");
    expect(run("fact", "--repo", "o/r", "--bogus").status).toBe(2);
  });
});
