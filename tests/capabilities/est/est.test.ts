import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import {
  branchHasIssue, branchIssueNumber, branchType, calib, computeFact, EstError, extractKeptLines, factCommentBody,
  cloudPartsIn, cloudSessionsIn, descSize, fmtH, forecast, guestTranscripts, hashMatches, historyTable, inRepo, sidKey, mergeIntervals, packPr, parseCloudFile, parseCodexFile, parseMarker, parseSessionFile, parseSince, plural, resolveLinks,
  pickAnalogs, roundScale, usageCost,
} from "../../../skills/est/scripts/est.ts";
import type { CloudPart, FactRepo, PR, Row, Session } from "../../../skills/est/scripts/est.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
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
 * Задачу, которую делают параллельные субагенты, часы сжимаются, а токены растут: каждый субагент заново читает
 * контекст. Число субагентов задачи — признак, по которому подбираются аналоги с тем же фан-аутом.
 */
describe("Фан-аут задачи — число её субагентов в факте и в истории", () => {
  it("число субагентов задачи — в факте, в комментарии и в маркере; субагенты другой задачи не в счёт", () => {
    const file = claudeFixture();
    const subs = path.join(dir, "11111111-2222-3333-4444-555555555555", "subagents");
    const sub = (hhmm: string, task: string) =>
      jsonl([
        { type: "user", timestamp: `2026-09-01T${hhmm}:00Z`, gitBranch: "feat/42-export", message: { content: task } },
        { type: "assistant", timestamp: `2026-09-01T${hhmm}:30Z`, gitBranch: "feat/42-export", message: { id: `msg_${hhmm}`, model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] } },
      ]);
    writeFileSync(path.join(subs, "agent-2.jsonl"), sub("10:09", "Задача #42: проверь линт"));
    writeFileSync(path.join(subs, "agent-3.jsonl"), sub("10:09", "Задача #43: другое"));
    const res = computeFact(stubRepo([parseSessionFile(file)], [pr77()]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    expect(res.agents).toBe(2);
    const body = factCommentBody(res, 0.25, [], 0, null);
    expect(body).toContain("1 сессия, 3 промпта, 2 субагента,");
    expect(body).toContain('"agents": 2');
  });

  it("субагент с заданием «Задача #42 (эпик #40)» считается задаче 42 целиком; «Задача #40 (эпик #42)» — нет", () => {
    const file = claudeFixture();
    const subs = path.join(dir, "11111111-2222-3333-4444-555555555555", "subagents");
    // ветка субагента — worktree без номера задачи: без подсказки его записи ни ветке, ни окнам не достаются
    const sub = (hhmm: string, task: string) =>
      jsonl([
        { type: "user", timestamp: `2026-09-01T${hhmm}:00Z`, gitBranch: "claude/agent-1a2b3c", message: { content: task } },
        { type: "assistant", timestamp: `2026-09-01T${hhmm}:30Z`, gitBranch: "claude/agent-1a2b3c", message: { id: `msg_${hhmm}`, model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] } },
      ]);
    writeFileSync(path.join(subs, "agent-2.jsonl"), sub("10:09", "Задача #42 (эпик #40): перенеси спеку в тесты"));
    writeFileSync(path.join(subs, "agent-3.jsonl"), sub("10:09", "Задача #40 (эпик #42): другое"));
    const res = computeFact(stubRepo([parseSessionFile(file)], [pr77()]), 42, [{ ...pr77(), why: "закрыл issue" }], []);
    expect(res.agents).toBe(2);
    expect(res.details[0]!.rules["субагент"]).toBe(4); // agent-1 и agent-2 — по две записи
  });

  it("история показывает число субагентов задачи; у факта без признака — прочерк", () => {
    const row = (number: number, agents?: number): Row => ({
      item_id: "", issue_id: "", number, title: `Задача ${number}`, state: "CLOSED", stateReason: "COMPLETED", closedAt: 0, createdAt: 0, labels: [],
      est: 1, fact: 0.5, status: "Готово", est_marker: { type: "feat" }, fact_marker: { cov: "full", tok: { total: 2e6 }, usd: 1.5, ...(agents === undefined ? {} : { agents }) },
    });
    const lines = historyTable([row(12, 4), row(13)]);
    expect(lines[0]).toContain(" | аг. | ");
    expect(lines[1]).toMatch(/ \|\s+4 \| /);
    expect(lines[2]).toMatch(/ \|\s+— \| /);
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
 * Хеш коммита в выводе инструмента привязывает сессию к PR этого коммита. Но канон велит смотреть на соседей
 * (`git worktree list`, `git branch -a`, `git fetch`), и их вывод перечисляет чужие коммиты — свежие, рядом по
 * времени. Хеш из такого листинга — якорь, только если этот коммит сделала сама сессия: он есть и в выводе её
 * `git commit`, `git push` или скрипта.
 */
describe("Хеш в листинге git — якорь, только если коммит сделала сама сессия", () => {
  const SID = "55555555-6666-7777-8888-999999999999";
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00Z`;
  const B = "fix/10-login";
  let n = 0;
  const bash = (hhmm: string, command: string, out: string, gitBranch = B) => {
    const id = `tu${++n}`;
    return [
      { type: "assistant", timestamp: at(hhmm), cwd: "/repo", gitBranch, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
      { type: "user", timestamp: at(hhmm), cwd: "/repo", gitBranch, message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] } },
    ];
  };
  const work = (hhmm: string, gitBranch = "HEAD") => ({ type: "assistant", timestamp: at(hhmm), cwd: "/repo", gitBranch, message: { content: [{ type: "text", text: "…" }] } });
  const OWN = "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3";
  const FOREIGN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const pr20: PR = { ...pr77(), number: 20, headRefName: B, closing: [10], body: "Closes #10", mergedAt: ts("10:10"), commits: [{ oid: OWN, at: ts("10:06") }] };
  const pr21: PR = { ...pr77(), number: 21, headRefName: "fix/12-signup", closing: [12], body: "Closes #12", commits: [{ oid: FOREIGN, at: ts("10:15") }] };

  function parse(records: unknown[]): Session {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl(records));
    return parseSessionFile(file);
  }

  // так было: `est fact 12` засчитал время сессии #10, а у #10 чужой якорь оборвал окно названия
  it("сессия «#10 …», в выводе которой только листинг с хешем PR задачи #12, отдаёт время #10, а не #12", () => {
    const s = parse([
      { type: "custom-title", customTitle: "#10 Логин", sessionId: SID },
      { type: "user", timestamp: at("10:00"), cwd: "/repo", gitBranch: B, origin: { kind: "human" }, message: { role: "user", content: "#10 почини логин" } },
      ...bash("10:06", 'git commit -m "fix: логин"', `[${B} e4f5a6b] fix: логин`),
      { type: "pr-link", timestamp: at("10:08"), prNumber: 20 },
      work("10:14"), work("10:17"),
      // после мержа — соседи по канону; wt-12 только что закоммитил PR задачи #12
      ...bash("10:20", "git worktree list", "/repo          0a0b0c0 (detached HEAD)\n/wt-12         a1b2c3d [fix/12-signup]", "HEAD"),
      work("10:25"), work("10:30"),
    ]);
    const repo = stubRepo([s], [pr20, pr21]);
    const f12 = computeFact(repo, 12, [{ ...pr21, why: "закрыл issue" }], []);
    expect(f12.h).toBeNull();
    expect(f12.cov).toBe("none");
    const f10 = computeFact(repo, 10, [{ ...pr20, why: "закрыл issue" }], []);
    expect(f10.h).toBe(0.5); // 10:00–10:30: чужой хеш не обрывает окно названия
  });

  it("листинг git и чтение через gh дают якорем только коммит из вывода самой сессии; скрипт рядом и gh pr view — как git commit", () => {
    const s = parse([
      ...bash("10:06", "bun scripts/ship.ts", `проверки ок\n[${B} e4f5a6b] fix: логин`),
      ...bash("10:20", "git log --oneline -3", "e4f5a6b fix: логин\n0a0b0c0 Merge pull request #19\n9f8e7d6 feat: регистрация"),
      ...bash("10:21", "git fetch --prune 2>&1 && git -C ../wt-12 branch -v | head -5", "   b2c3d4e..a1b2c3d  fix/12-signup -> origin/fix/12-signup\n* fix/12-signup a1b2c3d fix: регистрация"),
      ...bash("10:22", `gh issue view 12 --json title --jq .title; gh api graphql -f query='query{repository(owner:"o",name:"r"){pullRequest(number:21){commits(last:1){nodes{commit{oid}}}}}}'`, '{"oid":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"}'),
      // скрипт мог закоммитить сам, не напечатав хеш: его коммит виден только в git log той же команды
      ...bash("10:25", "bun scripts/amend.ts && git log -1 --oneline", "c0ffee1 fix: правка ревью"),
      // SKILL.md советует напечатать коммиты своего PR перед est fact — это якорь
      ...bash("10:26", "gh pr view 20 --json commits --jq '.commits[].oid'", "b0b0b0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"),
    ]);
    expect(s.commits).toEqual([[ts("10:06"), "e4f5a6b"], [ts("10:20"), "e4f5a6b"], [ts("10:25"), "c0ffee1"], [ts("10:26"), "b0b0b0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"]]);
  });

  // так было (#142): ключевые слова цикла делали всю проверку соседей «скриптом», и хеш wt-12 оставался якорем
  it("проверка соседей одной командой с циклом for по задачам — листинг: хеш соседнего worktree не якорь", () => {
    const s = parse([
      ...bash("10:20", `cd /repo && git fetch -q --prune origin; gh pr list --state open --json number,title,headRefName --jq '.[] | "pr \\(.number) \\(.headRefName)"'; git branch -a --list "*/1[0-9]-*" | sed 's/^/br /'; git worktree list | sed 's/^/wt /'; for n in 11 12 13; do gh issue view $n --json number,labels,body --jq '.number'; done`, "wt /wt-12         a1b2c3d [fix/12-signup]"),
      ...bash("10:21", "git branch --format='%(refname:short)' | while read b; do if git merge-base --is-ancestor $b origin/main; then echo \"влита $b\"; else git log -1 --oneline $b; fi; done", "a1b2c3d fix: регистрация"),
    ]);
    expect(s.commits).toEqual([]);
  });

  // сторож от перекоррекции: цикл и условие не делают листингом команду внутри них
  it("цикл или условие с git commit внутри — не листинг: хеш коммита — якорь", () => {
    const s = parse([
      ...bash("10:06", `for f in a b; do git add $f && git commit -m "fix: $f"; done`, `[${B} e4f5a6b] fix: a`),
      ...bash("10:08", "if git diff --quiet; then git log -1 --oneline; else git commit -am 'fix: ревью'; fi", `[${B} c0ffee1] fix: ревью`),
    ]);
    expect(s.commits).toEqual([[ts("10:06"), "e4f5a6b"], [ts("10:08"), "c0ffee1"]]);
  });
});

/**
 * Разговор в сессии одного репозитория перерастает в задачу другого: задачу заводят там же, сессию переименовывают
 * «#N …», коммит и PR — в другом репозитории. Такая сессия — гость: её транскрипт лежит в каталоге чужого
 * репозитория, а номера задач у репозиториев свои. Поэтому гостя привязывают только признаки, в которых есть
 * репозиторий задачи: её PR и коммиты, точная ветка её PR, URL её issue; номер в названии — лишь вместе с ними.
 */
describe("Сессия из каталога другого репозитория даёт факт задаче только по признакам её репозитория", () => {
  const SID = "44444444-5555-6666-7777-888888888888";
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00Z`;
  // сессия открыта в каталоге репозитория o/r, её ветка — своя, с тем же номером 57
  const B = "feat/57-legacy";
  const work = (hhmm: string, out = "…", gitBranch = B) => ({ type: "user", timestamp: at(hhmm), cwd: "/b", gitBranch, message: { content: [{ type: "tool_result", tool_use_id: "t", content: out }] } });
  const prompt = (hhmm: string, text: string, gitBranch = B) => ({ type: "user", timestamp: at(hhmm), cwd: "/b", gitBranch, origin: { kind: "human" }, message: { role: "user", content: text } });
  const rename = (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: SID });
  const prLink = (hhmm: string, prNumber: number, prRepository: string) => ({ type: "pr-link", timestamp: at(hhmm), prNumber, prRepository, prUrl: `https://github.com/${prRepository}/pull/${prNumber}` });
  const OID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  // PR #7 задачи #57 репозитория o/a
  const pr7: PR = { ...pr77(), number: 7, headRefName: "docs/57-rules", closing: [57], body: "Closes #57", commits: [{ oid: OID, at: ts("10:10") }], mergedAt: ts("11:00") };

  function session(lines: unknown[]): Session {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl(lines));
    return parseSessionFile(file);
  }
  const discussion = [rename("Обсуждение правил"), prompt("09:00", "обсудим правила"), work("09:10"), work("09:15")];
  const task = [rename("#57 Правила · новое"), prompt("10:00", "заведи задачу и сделай"), work("10:10", `[docs/57-rules ${OID.slice(0, 7)}] правила`), prLink("10:20", 7, "o/a"), work("10:25")];
  const inA = (s: Session) => ({ ...stubRepo([{ ...s, guest: true }], [pr7]), full: "o/a" });

  it("сессия из каталога другого репозитория с PR и коммитом задачи даёт ей факт — с переименования под задачу, ветка того репозитория не в счёт", () => {
    const res = computeFact(inA(session([...discussion, ...task])), 57, [{ ...pr7, why: "закрыл issue" }], []);
    expect(res.h).toBe(0.42); // 10:00–10:25; обсуждение 09:00–09:15 на ветке feat/57-legacy — не задача o/a#57
    expect(res.cov).toBe("full");
    expect(res.details[0]!.rules.ветка).toBeUndefined();
  });

  it("та же сессия не даёт факта задаче своего репозитория с тем же номером — период с PR другого репозитория не её", () => {
    // сессия на main репозитория o/r: период «#57» — с PR o/a#7, задача o/r#57 его не получает
    const s = session([
      prompt("09:00", "обсудим правила", "main"), work("09:10", "…", "main"),
      rename("#57 Правила · новое"), prompt("10:00", "заведи задачу и сделай", "main"), work("10:10", "…", "main"), prLink("10:20", 7, "o/a"), work("10:25", "…", "main"),
    ]);
    const res = computeFact(stubRepo([s], []), 57, [], []);
    expect(res.h).toBeNull();
    expect(res.cov).toBe("none");
  });

  it("номер в названии сессии другого репозитория без признака репозитория задачи — не привязка", () => {
    // на main: привязать могло бы только название
    const s = session([rename("#57 Правила"), prompt("10:00", "сделай #57", "main"), work("10:10", "…", "main"), work("10:20", "…", "main")]);
    const res = computeFact(inA(s), 57, [{ ...pr7, why: "закрыл issue" }], []);
    expect(res.h).toBeNull();
    expect(res.cov).toBe("none");
  });

  it("pr-link PR другого репозитория с тем же номером — не якорь", () => {
    // своя сессия o/r, PR #7 есть и у o/r (задача #9), но ссылка — на PR #7 репозитория o/a
    const own: PR = { ...pr77(), number: 7, headRefName: "fix/9-x", closing: [9], body: "Closes #9", commits: [] };
    const s = session([prompt("10:00", "посмотри", "main"), work("10:10", "…", "main"), prLink("10:20", 7, "o/a"), work("10:25", "…", "main")]);
    const res = computeFact(stubRepo([s], [own]), 9, [{ ...own, why: "закрыл issue" }], []);
    expect(res.h).toBeNull();
  });

  it("сессия другого репозитория — кандидат, только если в её транскрипте есть имя репозитория задачи", () => {
    const projects = path.join(dir, "projects");
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(projects, rel)), { recursive: true });
      writeFileSync(path.join(projects, rel), text);
    };
    put("-work-b/s1.jsonl", '{"type":"pr-link","prRepository":"o/a"}\n');
    put("-work-b/s2.jsonl", '{"text":"работа в foo/abc и o/ab"}\n');
    put("-work-b/s3.jsonl", '{"text":"без упоминаний"}\n');
    put("-work-b/s3/subagents/agent-1.jsonl", '{"text":"git -C ~/work/a push https://github.com/o/a.git"}\n');
    put("-work-a/s4.jsonl", '{"prRepository":"o/a"}\n');
    const found = guestTranscripts("o/a", ["/work/a"], ["/work/b"], projects).map((f) => path.relative(projects, f));
    expect(found).toEqual(["-work-b/s1.jsonl", "-work-b/s3.jsonl"]);
  });
});

/**
 * Сессия приложения Claude без выбранной папки работает во временной папке приложения (`…/Claude/scratch-workspaces/…`),
 * потом переходит в репозиторий задачи (`change_directory`), а транскрипт остаётся в каталоге временной папки, пока
 * приложение не перенесёт его в каталог репозитория — уже после закрытия задачи. Такая сессия — гость любого
 * репозитория реестра: кандидат по имени репозитория задачи в транскрипте, привязка — его признаками.
 */
describe("Сессия из временной папки приложения — гость любого репозитория реестра", () => {
  const SID = "55555555-6666-7777-8888-999999999999";
  const SCRATCH_CWD = "/Users/u/Library/Application Support/Claude/scratch-workspaces/0a1b/2c3d/scratch-2026-09-01-abc123";
  const SCRATCH = SCRATCH_CWD.replace(/[^A-Za-z0-9]/g, "-");
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00Z`;
  const prompt = (hhmm: string, text: string) => ({ type: "user", timestamp: at(hhmm), cwd: SCRATCH_CWD, gitBranch: "", origin: { kind: "human" }, message: { role: "user", content: text } });
  const work = (hhmm: string) => ({ type: "user", timestamp: at(hhmm), cwd: SCRATCH_CWD, gitBranch: "", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "…" }] } });
  const projects = () => path.join(dir, "projects");
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(projects(), rel)), { recursive: true });
    writeFileSync(path.join(projects(), rel), text);
  };
  const candidates = () => guestTranscripts("o/a", ["/work/a"], ["/work/b"], projects());

  it("сессия из временной папки приложения с именем репозитория задачи — кандидат-гость", () => {
    put(`${SCRATCH}/s1.jsonl`, '{"text":"#57 — задача репозитория o/a (https://github.com/o/a/issues/57)"}\n');
    put(`${SCRATCH}/s2.jsonl`, '{"text":"без упоминаний"}\n');
    put(`${SCRATCH}/s2/subagents/agent-1.jsonl`, '{"prRepository":"o/a"}\n');
    expect(candidates().map((f) => path.relative(projects(), f))).toEqual([`${SCRATCH}/s1.jsonl`, `${SCRATCH}/s2.jsonl`]);
  });

  it("сессия из временной папки без имени репозитория задачи — не кандидат", () => {
    put(`${SCRATCH}/s1.jsonl`, '{"text":"работа в foo/abc и o/ab"}\n');
    put(`${SCRATCH}/s2.jsonl`, '{"text":"без упоминаний"}\n');
    expect(candidates()).toEqual([]);
  });

  it("задача без PR из такой сессии получает факт по названию и URL issue", () => {
    const title = { type: "custom-title", customTitle: "#57 Замер · неделя без очереди", sessionId: SID };
    put(`${SCRATCH}/${SID}.jsonl`, jsonl([title, prompt("10:00", "#57 — задача репозитория o/a (https://github.com/o/a/issues/57): замерь"), work("10:10"), work("10:20")]));
    const sessions = candidates().map((f) => ({ ...parseSessionFile(f), guest: true }));
    const res = computeFact({ ...stubRepo(sessions, []), full: "o/a" }, 57, [], []);
    expect(res.h).toBe(0.33); // 10:00–10:20
    expect(res.details[0]!.rules.название).toBe(3);
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

  it("PR ветки с другим номером в каноническом месте задаче не достаётся, хотя её номер есть в слаге", () => {
    const [prs] = resolveLinks(repo([pr(70, [128], "Closes #128", "fix/128-api-409-on-retry"), pr(71, [136], "Closes #136", "docs/136-api-409-schema")]), issue(409));
    expect(prs.map((p) => p.number)).toEqual([]);
  });
});

/** Номер привязывает работу к задаче, тип нужен истории оценок — аналоги ищутся среди задач того же типа. */
describe("Ветка `<type>/<issue>-<slug>` даёт номер и тип задачи", () => {
  it("в канонической ветке номер задачи — первое число после типа, число в слаге номером не считается", () => {
    expect(branchHasIssue("feat/42-invoice-export", 42)).toBe(true);
    expect(branchHasIssue("fix/7-login", 7)).toBe(true);
    expect(branchHasIssue("fix/128-api-409-on-retry", 128)).toBe(true);
    expect(branchHasIssue("fix/128-api-409-on-retry", 409)).toBe(false);
    expect(branchHasIssue("backend/docs/136-api-409-schema", 136)).toBe(true);
    expect(branchHasIssue("backend/docs/136-api-409-schema", 409)).toBe(false);
    expect(branchHasIssue("feat/420-x", 42)).toBe(false);
  });

  it("в неканонической ветке номер — отдельный токен, даты и однозначные числа без issue- не считаются", () => {
    expect(branchHasIssue("issue-7-login", 7)).toBe(true);
    expect(branchHasIssue("gh-15-sync", 15)).toBe(true);
    expect(branchHasIssue("api-409-on-retry", 409)).toBe(true);
    expect(branchHasIssue("release/2026-09-16", 9)).toBe(false);
    expect(branchHasIssue("hotfix-7-login", 7)).toBe(false);
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

  /** Подсказка задачи у записей субагента по его заданию; ветка субагента — worktree без номера задачи. */
  const subHints = (task: string) => {
    const sid = "22222222-3333-4444-5555-666666666666";
    const file = path.join(dir, sid + ".jsonl");
    writeFileSync(file, jsonl([{ type: "user", timestamp: "2026-09-01T10:00:00Z", cwd: "/repo", gitBranch: "feat/42-export", message: { role: "user", content: "#42 сделай экспорт" } }]));
    mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
    writeFileSync(
      path.join(dir, sid, "subagents", "agent-1.jsonl"),
      jsonl([
        { type: "user", timestamp: "2026-09-01T10:07:00Z", gitBranch: "claude/agent-1a2b3c", message: { content: task } },
        { type: "assistant", timestamp: "2026-09-01T10:08:00Z", gitBranch: "claude/agent-1a2b3c", message: { id: "msg_sub_0001", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] } },
      ]),
    );
    return parseSessionFile(file).ev.filter((e) => e[5] > 0).map((e) => e[3]);
  };

  it("задание субагенту «Задача #42 (эпик #40). …» даёт подсказку 42: номер после «эпик» — не задача", () => {
    expect(subHints("Задача #42 (эпик #40). Перенеси спеку в тесты")).toEqual(["42", "42"]);
  });

  it("задание, начинающееся с «#42 (эпик #40)», даёт подсказку 42", () => {
    expect(subHints("#42 (эпик #40): перенеси спеку в тесты")).toEqual(["42", "42"]);
  });

  it("ссылка на issue и «(эпик #40)» в задании — подсказка по ссылке, с репозиторием", () => {
    expect(subHints("Задача https://github.com/o/r/issues/42 (эпик #40): перенеси спеку")).toEqual(["o/r#42", "o/r#42"]);
  });

  it("два номера без слов «Задача» и «эпик» и не в начале — подсказки нет, записи субагента идут по ветке и окнам", () => {
    expect(subHints("посмотри #42 и #39, потом ответь")).toEqual(["", ""]);
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

  // Сессия приложения без проекта, перенесённая в репозиторий и дальше в worktree: каталог первой записи — не
  // репозиторий, и факт всех её задач был «недоступен» (#93)
  it("сессия, перешедшая в каталог репозитория по ходу работы, относится к нему; сессия целиком вне репозитория — нет", () => {
    const rec = (hhmm: string, cwd: string, content: string) => ({
      type: "user", timestamp: `2026-09-01T${hhmm}:00Z`, cwd, gitBranch: "HEAD", origin: { kind: "human" }, message: { role: "user", content },
    });
    const moved = path.join(dir, "moved.jsonl");
    writeFileSync(moved, jsonl([
      rec("10:00", "/scratch/session-1", "обсудим правила"),
      rec("10:10", "/repo", "#42 сделай"),
      rec("10:20", "/repo/.claude/worktrees/epic", "дальше"),
    ]));
    const outside = path.join(dir, "outside.jsonl");
    writeFileSync(outside, jsonl([rec("10:00", "/scratch/session-2", "вопрос"), rec("10:05", "/repo-other", "ещё")]));
    expect(inRepo(parseSessionFile(moved), ["/repo"])).toBe(true);
    expect(inRepo(parseSessionFile(outside), ["/repo"])).toBe(false);
  });
});

/** У записей Codex нет ветки — привязка к задаче только по номеру в промпте и хешам коммитов. */
describe("Транскрипт Codex — такой же источник факта, только без ветки", () => {
  it("cwd и id из session_meta, промпт из UserMessage, токены раз на response_id, хеши из выводов инструментов, кроме чужих в листинге git", () => {
    const file = path.join(dir, "rollout-1.jsonl");
    writeFileSync(file, jsonl([
      { type: "session_meta", payload: { cwd: "/repo", id: "codex-1" } },
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      { type: "event_msg", timestamp: "2026-09-01T10:00:00Z", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "#42 экспорт" }] } } },
      { type: "response_item", timestamp: "2026-09-01T10:01:00Z", payload: { type: "function_call", call_id: "c1", arguments: "{\"cmd\":\"git commit -m x\"}" } },
      { type: "response_item", timestamp: "2026-09-01T10:02:00Z", payload: { type: "function_call_output", call_id: "c1", output: "[main deadbeef1] x" } },
      { type: "response_item", timestamp: "2026-09-01T10:02:10Z", payload: { type: "function_call", call_id: "c2", arguments: "{\"command\":[\"bash\",\"-lc\",\"git worktree list\"]}" } },
      { type: "response_item", timestamp: "2026-09-01T10:02:20Z", payload: { type: "function_call_output", call_id: "c2", output: "/wt-12  a1b2c3d [fix/12-signup]" } },
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

  it("задание субагенту с номером задачи и номером эпика привязывает его записи к задаче", () => {
    const evs = events();
    // порядок событий — по sequence_num: задание субагента подменяется на месте, не новым событием
    evs[8] = { ...evs[8]!, payload: { ...evs[8]!.payload, message: { role: "user", content: "Задача #42 (эпик #40): проверь экспорт" } } };
    const s = parseCloudFile(exportFile(evs));
    expect(s.ev.filter((e) => e[3]).map((e) => e[3])).toEqual(["42", "42"]);
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

    it("облачная часть несёт ходы, хвост и контекст; локальный расчёт складывает ходы и хвост с местными, преамбулу берёт у самой ранней, контекст в конце — у самой поздней", () => {
      const withSteps: CloudPart = { ...part, iv: [[ts("09:50"), ts("10:12")]], steps: 5, steps_agents: 2, tail: 1, preamble: 90_000, ctx_end: 300_000 };
      const local = parseCloudFile(exportFile(events()));
      local.sid = "local-session";
      local.source = "claude";
      const res = fact([local], [withSteps]);
      expect(res).toMatchObject({ steps: 8, steps_agents: 3, tail: 1, preamble: 90_000, ctx_end: 300_000 });
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
    expect(body).toContain("Факт: 0.22 ч активных в Claude Code (оценка 1 ч, ×0.22). 1 сессия, 3 промпта, 1 субагент, стена 0.2 ч, покрытие full. PR #77; 1 коммит, дифф 12 строк.");
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
/** Фан-аут меняет токены сильнее часов: у поправки токенов и стоимости своя ступень. */
describe("Прогноз по фактам аналогов — медиана с поправкой", () => {
  it("поправка токенов задаётся отдельно от поправки часов", () => {
    const f = forecast([0.2, 0.4], [10, 20], [5, 10], 1, 2);
    expect([f.h, f.tok, f.usd]).toEqual([0.25, 30, 15]);
  });

  it("без поправки токенов токены и стоимость следуют поправке часов", () => {
    const f = forecast([0.2, 0.4], [10, 20], [5, 10], 2);
    expect([f.h, f.tok, f.usd]).toEqual([0.5, 30, 15]);
  });
});

describe("Оценка — ступень шкалы от 0,1 до 13 ч", () => {
  it("округляет к ближайшей ступени, при равном расстоянии — к меньшей, выше 13 не бывает", () => {
    expect(roundScale(2.6)).toBe(3);
    expect(roundScale(0.175)).toBe(0.1);
    expect(roundScale(0.4)).toBe(0.5);
    expect(roundScale(20)).toBe(13);
  });
});

// `gh` — внешний край, подменяется он: ответы — из мира $FAKE_GH/world.json (репозиторий → видимость, номер проекта,
// задачи с фактом), каждый вызов — строкой JSON в $FAKE_GH/calls.jsonl.
const FAKE_GH = `import { appendFileSync, readFileSync } from "node:fs";
const dir = process.env.FAKE_GH;
const args = process.argv.slice(2);
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : "";
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args, stdin }) + "\\n");
const world = JSON.parse(readFileSync(dir + "/world.json", "utf8"));
const print = (x) => console.log(JSON.stringify(x));
const num = (name, number) => ({ __typename: "ProjectV2ItemFieldNumberValue", number, field: { name } });
const factMarker = (i) => "<!-- fact " + JSON.stringify({ v: 1, h: i.fact, cov: i.cov ?? "full", tok: { total: 2000000 }, usd: 1.5, type: i.type ?? "fix" }) + " -->";
const estMarker = (i) => "<!-- est " + JSON.stringify({ v: 2, h: i.est, type: i.type ?? "fix", mult: i.mult ?? 1 }) + " -->";
const issueOf = (i) => ({ __typename: "Issue", id: "I_" + i.number, number: i.number, title: i.title, state: i.state, stateReason: null,
  closedAt: i.closedAt ?? null, createdAt: i.createdAt ?? null, body: i.body ?? "", labels: { nodes: (i.labels ?? []).map((name) => ({ name })) },
  comments: { nodes: [...(i.est ? [{ databaseId: 1000 + i.number, body: estMarker(i) }] : []), ...(i.fact ? [{ databaseId: i.number, body: factMarker(i) }] : [])] } });
if (args[1] === "graphql") {
  const { query, variables: v } = JSON.parse(stdin);
  const repo = world[v.o + "/" + v.r];
  const byProject = (pred) => Object.values(world).find((r) => pred(r.project));
  if (/^\\s*mutation/.test(query)) print({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.i } } } });
  else if (query.includes("projectsV2(first:5)")) print({ data: { repository: { projectsV2: { nodes: [{ number: repo.project, title: "p", owner: { login: v.o } }] } } } });
  else if (query.includes("projectV2(number:$n)")) {
    const fields = { nodes: [{ id: "F_est", name: "Оценка, ч" }, { id: "F_fact", name: "Факт, ч" }, { id: "F_st", name: "Status", options: [] }] };
    const owner = query.includes("organization(") ? "organization" : "user";
    print({ data: { [owner]: { projectV2: { id: "P" + v.n, title: "p", number: v.n, fields } } } });
  } else if (query.includes("node(id:$id)")) {
    const r = byProject((p) => "P" + p === v.id);
    const fieldValues = (i) => ({ nodes: [...(i.fact ? [num("Факт, ч", i.fact)] : []), ...(i.est ? [num("Оценка, ч", i.est)] : [])] });
    const nodes = r.issues.map((i) => ({ id: "PI_" + i.number, type: "ISSUE", content: issueOf(i), fieldValues: fieldValues(i) }));
    print({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
  } else if (query.includes("issue(number:$n)")) {
    const i = repo.issues.find((x) => x.number === v.n);
    print({ data: { repository: { issue: { ...issueOf(i), url: "", timelineItems: { nodes: [] }, closedEvents: { nodes: [] },
      projectItems: { nodes: [{ id: "PI_" + i.number, project: { id: "P" + repo.project }, fieldValues: { nodes: [] } }] }, comments: { nodes: [] } } } } });
  } else { console.error("fake gh: " + query.slice(0, 80)); process.exit(1); }
} else if (args[0] === "api" && args[1] === "-X") {
  const [, owner, name] = /^repos\\/([^/]+)\\/([^/]+)/.exec(args[3]);
  if (args[2] === "GET" && args[3] === "repos/" + owner + "/" + name) print({ visibility: world[owner + "/" + name].visibility });
  else print({});
} else { console.error("fake gh: " + args.join(" ")); process.exit(1); }
`;

/** `est <args>` с фейковым gh в мире `world` (все его репо — в реестре): исход, записи в GitHub, тело нового комментария. */
function withFakeGh(world: Record<string, unknown>, args: string[]) {
  const bin = path.join(dir, "bin");
  const cfg = path.join(dir, "ai-dev");
  mkdirSync(bin, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path.join(bin, "fake-gh.mjs"), FAKE_GH);
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\nexec bun "$FAKE_GH/fake-gh.mjs" "$@"\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "world.json"), JSON.stringify(world));
  writeFileSync(path.join(cfg, "repos.json"), JSON.stringify(Object.fromEntries(Object.keys(world).map((k) => [k, {}]))));
  const log = path.join(bin, "calls.jsonl");
  writeFileSync(log, "");
  const r = spawnSync("bun", [EST, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: cfg, CLAUDE_CODE_REMOTE: "", PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin } });
  const calls: { args: string[]; stdin: string }[] = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const writes = calls.filter((c) => c.args.includes("POST") || c.args.includes("PATCH") || /^\s*mutation/.test(c.args[1] === "graphql" ? JSON.parse(c.stdin).query : ""));
  const comment = calls.filter((c) => c.args.includes("POST")).map((c) => JSON.parse(c.stdin).body as string)[0] ?? null;
  return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr, writes, comment };
}

/**
 * Комментарий «Оценка» называет аналог из другого репо как `owner/repo#N`. В публичном репо это раскрыло бы имя и номер
 * задачи непубличного, а перезапись не спасает: GitHub хранит прошлую версию комментария в истории правок, стереть её
 * может только владелец. Поэтому такую оценку `--write` не пишет вовсе, а без `--write` о ней предупреждает.
 */
describe("Оценка в публичном репо не называет задачи непубличных репо", () => {
  const repoWorld = (visibility: string, project: number) => ({
    visibility, project,
    issues: [{ number: 1, title: "Прошлая задача", state: "CLOSED", fact: 0.5 }, { number: 2, title: "Ещё прошлая", state: "CLOSED", fact: 1 }, { number: 10, title: "Новая задача", state: "OPEN" }],
  });
  const WORLD = { "o/pub": repoWorld("public", 1), "o/pub2": repoWorld("public", 2), "o/priv": repoWorld("private", 3), "o/priv2": repoWorld("private", 4) };

  /** `est estimate 10 --repo <repo> --type fix --analogs <analogs>` с фейковым gh: исход, записи в GitHub, тело комментария. */
  const estimate = (repo: string, analogs: string, write = true) =>
    withFakeGh(WORLD, ["estimate", "10", "--repo", repo, "--type", "fix", "--analogs", analogs, ...(write ? ["--write"] : [])]);

  it("в публичный репо не пишется аналог из непубличного репо — отказ до записи", () => {
    const r = estimate("o/pub", "1,o/priv#1,o/priv#2");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ошибка: o/pub — публичный репо, а аналоги o/priv#1, o/priv#2 — из непубличного");
    expect(r.stderr).toContain("--hours");
    expect(r.writes).toEqual([]);
  });

  it("без --write аналог из непубличного репо в публичный — предупреждение, оценка только печатается", () => {
    const r = estimate("o/pub", "o/priv#1,o/priv#2", false);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("предупреждение: o/pub — публичный репо, а аналоги o/priv#1, o/priv#2 — из непубличного");
    expect(r.stdout).toContain("Оценка: 0.5 ч");
    expect(r.writes).toEqual([]);
  });

  it("аналоги из того же репо — оценка записывается как раньше", () => {
    const r = estimate("o/pub", "1,2");
    expect(r.code).toBe(0);
    expect(r.comment).toStartWith("Оценка: 0.5 ч");
    expect(r.writes).toHaveLength(2); // комментарий и поле «Оценка, ч»
  });

  it("аналог из другого репо пишется, если тот публичный или целевой репо непубличный", () => {
    for (const [repo, analogs, from] of [["o/pub", "o/pub2#1,o/pub2#2", "o/pub2"], ["o/priv", "o/priv2#1,o/priv2#2", "o/priv2"]] as const) {
      const r = estimate(repo, analogs);
      expect(r.code).toBe(0);
      expect(r.comment).toContain(`из проекта ${from}: #1 (факт 0.5 ч), #2 (факт 1 ч)`);
      expect(r.writes).toHaveLength(2);
    }
  });
});

/**
 * Оценка — один вызов: без `--analogs` аналоги подбирает скрипт среди закрытых задач с фактом (покрытие full, не
 * эпиков), закрытых до создания оцениваемой. Сходство — сумма признаков: общая метка решения ×3, тот же тип ×2, общее
 * слово заголовка ×1, минус 3 × |ln| отношения размеров описаний; берутся три самых похожих, при равенстве — свежие.
 * Веса выбраны бэктестом (#279): размер описания — признак объёма не слабее меток, поэтому он в сумме, а не последним
 * в очереди признаков. Размер считается без ответов на вопросы — их дописывают после оценки.
 */
describe("Аналоги подбирает скрипт — по меткам решений, типу, словам заголовка и размеру описания", () => {
  const row = (n: number, o: Partial<Row> = {}): Row => ({
    item_id: "i", issue_id: "I", number: n, title: "Прочее", state: "CLOSED", stateReason: null, closedAt: 500 + n, createdAt: 1, labels: [],
    est: null, fact: 1, status: null, est_marker: null, fact_marker: { cov: "full", type: "fix" }, size: 1000, ...o,
  });
  const target = { number: 99, title: "Биллинг · экспорт счетов в PDF", labels: ["billing"], createdAt: 1000, size: 1000 };

  it("аналоги — три самых похожих по сумме признаков: общая метка решения, тот же тип, общие слова заголовка, близкий размер описания", () => {
    const feat = { cov: "full", type: "feat" };
    const rows = [
      row(1, { labels: ["billing"], title: "Биллинг · экспорт счетов в CSV", fact_marker: feat }),
      row(2, { labels: ["billing", "epic-x"], title: "Биллинг · скидки" }),
      row(3, { title: "Экспорт отчётов", fact_marker: feat }),
      row(4, { labels: ["billing"], title: "Биллинг · экспорт счетов в XLS", fact_marker: feat, size: 20000 }),
      row(5),
    ];
    const a = pickAnalogs(target, "feat", rows);
    expect(a.map((x) => x.row.number)).toEqual([1, 2, 3]);
    expect(a[0]).toMatchObject({ labels: ["billing"], sameType: true, words: ["биллинг", "экспорт", "счетов"], sizeRatio: 1 });
    expect(a[1]).toMatchObject({ labels: ["billing"], sameType: false, words: ["биллинг"] });
  });

  it("аналог оценки — только задача, закрытая до создания оцениваемой, с фактом full: бэктест не заглядывает в будущее", () => {
    const same = { labels: ["billing"], title: target.title };
    const rows = [
      row(1, { ...same, closedAt: 2000 }),
      row(2, { ...same, labels: ["billing", "epic"] }),
      row(3, { ...same, issueType: "Эпик" }),
      row(4, { ...same, fact_marker: { cov: "partial", type: "fix" } }),
      row(5, { ...same, state: "OPEN", closedAt: null, fact: null }),
      row(6, { ...same, fact: null }),
      row(99, same),
      row(7),
      row(8),
    ];
    expect(pickAnalogs(target, "feat", rows).map((x) => x.row.number)).toEqual([8, 7]);
  });

  it("размер описания — без ответов на вопросы: ответ, дописанный после оценки, размер не меняет", () => {
    const asked = "## Что сделать\nЭкспорт.\n\n## Вопросы\n1. Формат? Рекомендация: PDF.\n2. Шаблон? Рекомендация: из макета.\n\n## Готово, когда\nЕсть PDF.\n";
    const answered = "## Что сделать\nЭкспорт.\n\n## Вопросы\n1. ✅ Формат? Рекомендация: PDF. **Ответ (авто):** по рекомендации — PDF,\n   шаблон из макета.\n2. ✅ Шаблон? Рекомендация: из макета.\n   **Ответ:** из макета.\n\n## Готово, когда\nЕсть PDF.\n";
    expect(descSize(answered)).toBe(descSize(asked));
    expect(descSize(asked)).toBeGreaterThan(descSize("## Что сделать\nЭкспорт.\n"));
  });
});

/** Мир фейкового gh для оценки одним вызовом и бэктеста: задачи с метками, датами, описанием, фактом и ручной оценкой. */
const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}T00:00:00Z`;

describe("Оценка — один вызов: est estimate без --analogs", () => {
  const closed = (number: number, title: string, labels: string[], type: string, fact: number, d: number, extra: Record<string, unknown> = {}) =>
    ({ number, title, labels, type, fact, state: "CLOSED", createdAt: day(1), closedAt: day(d), body: "x".repeat(1000), ...extra });
  const WORLD = {
    "o/r": {
      visibility: "private", project: 1,
      issues: [
        closed(1, "est · история оценок по фактам", ["est"], "feat", 0.5, 2, { body: "x".repeat(800) }),
        closed(2, "est · факт из транскриптов", ["est"], "feat", 1, 3),
        closed(3, "github · закрытие задачи", ["github-task"], "fix", 4, 4),
        closed(4, "est · оценка по аналогам без ручного выбора", ["est"], "feat", 8, 20),
        closed(5, "est · оценка токенов", ["est"], "feat", 2, 5, { cov: "partial" }),
        { number: 10, title: "est · оценка одним вызовом", labels: ["est"], state: "OPEN", createdAt: day(10), body: "x".repeat(1000) },
      ],
    },
  };

  it("без --analogs скрипт выбирает аналоги по меткам решений, типу и словам заголовка и называет их в комментарии «Оценка»", () => {
    const r = withFakeGh(WORLD, ["estimate", "10", "--repo", "o/r", "--type", "feat", "--write"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.comment).toStartWith("Оценка: 1 ч");
    expect(r.comment).toContain("Аналоги (подбор скриптом): #1 (факт 0.5 ч: метка est · тип feat · слова «est», «оценка» · описание ×0.8); #2 (факт 1 ч: метка est · тип feat · слово «est» · описание ×1); #3 (факт 4 ч: описание ×1).");
    expect(r.comment).not.toContain("#4");
    expect(parseMarker(r.comment, "est")).toMatchObject({ h: 1, analogs: [1, 2, 3], auto: true });
    expect(r.writes).toHaveLength(2); // комментарий и поле «Оценка, ч»
  });
});

/**
 * Бэктест: каждая закрытая задача с фактом оценивается механикой так, как её оценил бы скрипт в день создания, — по
 * задачам, закрытым раньше; доля в допуске ×0,5…×2 и k (медиана факт/оценка) механики и ручных оценок — на одной
 * выборке, иначе сравнение нечестно. Третья строка — механика с поправкой, которую дал агент: видно, добавляет ли
 * поправка точности.
 */
describe("Бэктест сравнивает механическую оценку с ручной", () => {
  const task = (number: number, created: number, d: number, fact: number, extra: Record<string, unknown> = {}) =>
    ({ number, title: ["Альфа", "Бета", "Гамма", "Дельта", "Эпсилон", "Дзета", "Эта", "Тета"][number - 1], state: "CLOSED", createdAt: day(created), closedAt: day(d), fact, ...extra });
  const WORLD = {
    "o/b": {
      visibility: "private", project: 2,
      issues: [
        task(1, 1, 2, 1),
        task(2, 1, 3, 1),
        task(3, 4, 5, 1, { est: 4, mult: 2 }),
        task(4, 6, 8, 2, { est: 2 }),
        task(5, 7, 9, 4, { est: 1, mult: 2 }),
        task(6, 10, 11, 1),
        task(7, 1, 12, 9, { est: 9, labels: ["epic"] }),
        task(8, 10, 11, 3, { est: 3, cov: "partial" }),
      ],
    },
  };

  it("бэктест печатает долю в допуске ×0,5…×2 и k механики и ручных оценок на одной выборке", () => {
    const r = withFakeGh(WORLD, ["backtest", "--repo", "o/b"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("задач с фактом (покрытие full, без эпиков): 6; механике хватило аналогов (≥ 2): 4, в допуске ×0.5…×2 — 75 %, k=1.5");
    expect(r.stdout).toContain("на одной выборке с ручной оценкой, n=3:");
    expect(r.stdout).toMatch(/ {2}механика {2,}в допуске 67 %, k=2\n/);
    expect(r.stdout).toMatch(/ {2}ручная {2,}в допуске 33 %, k=1\n/);
    expect(r.stdout).toMatch(/ {2}механика × поправка ручной {2,}в допуске 100 %, k=2\n/);
    expect(r.writes).toEqual([]);
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

  it("метки решений в est history видны целиком — колонка по самой длинной", () => {
    const row = (number: number, labels: string[]): Row => ({
      item_id: "", issue_id: "", number, title: `Задача ${number}`, state: "CLOSED", stateReason: "COMPLETED", closedAt: 0, createdAt: 0, labels,
      est: 1, fact: 0.5, status: "Готово", est_marker: { type: "feat" }, fact_marker: { cov: "full", tok: { total: 2e6 }, usd: 1.5 },
    });
    const lines = historyTable([row(12, ["spec-harness", "spawn-timeout", "github-project"]), row(13, ["epic"])]);
    expect(lines[1]).toContain(" spec-harness,spawn-timeout,github-project | Задача 12");
    // заголовок и строки — одной ширины до названия задачи: колонки не съезжают
    expect(new Set(lines.map((l) => l.lastIndexOf(" | "))).size).toBe(1);
  });
});

describe("Неверный вызов — справка или ошибка до обращения к GitHub", () => {
  const run = (...args: string[]) => spawnSync("bun", [EST, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev"), CLAUDE_CODE_REMOTE: "" } });

  it("без команды — справка и код 2, неизвестная команда — ошибка", () => {
    expect(exitOf(run())).toBe(2);
    expect(run().stdout).toContain("est history");
    const r = run("frobnicate");
    expect(exitOf(r)).toBe(1);
    expect(r.stderr).toContain("ошибка: неизвестная команда «frobnicate»");
  });

  it("проверки аргументов — до обращения к GitHub", () => {
    expect(run("fact", "1", "--repo", "o/r", "--gap", "0").stderr).toContain("--gap должен быть ≥ 1 минуты");
    expect(run("fact", "1", "--sweep", "--repo", "o/r").stderr).toContain("номер issue и --sweep несовместимы");
    expect(run("estimate", "1", "--repo", "o/r").stderr).toContain("--type обязателен");
    expect(run("estimate", "--repo", "o/r", "--type", "feat").stderr).toContain("укажите номер issue");
    expect(run("estimate", "1", "--repo", "o/r", "--type", "feat", "--analogs", "2,3", "--tok-mult", "2.5").stderr).toContain("--tok-mult допускает только 0.5, 1, 1.5, 2 или 3");
    expect(exitOf(run("fact", "--repo", "o/r", "--bogus"))).toBe(2);
  });
});

/**
 * Цена задачи растёт квадратично от числа ходов: каждый ход заново читает весь контекст. Факт показывает ходы,
 * преамбулу (контекст первого хода), контекст в конце и хвост (ходы на контексте больше 400 тыс.) — иначе эффект
 * правил про субагентов и число ходов невидим.
 */
describe("Факт — ходы и контекст задачи", () => {
  const SID = "44444444-5555-6666-7777-888888888888";
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00Z`;
  const step = (hhmm: string, id: string, cr: number, branch = "feat/42-x") => ({ type: "assistant", timestamp: at(hhmm), gitBranch: branch, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: cr }, content: [{ type: "text", text: "…" }] } });
  const prompt = (hhmm: string, text: string, branch = "feat/42-x") => ({ type: "user", timestamp: at(hhmm), cwd: "/repo", gitBranch: branch, message: { role: "user", content: text } });
  function session(top: unknown[], sub: unknown[] = []): Session {
    const file = path.join(dir, SID + ".jsonl");
    writeFileSync(file, jsonl(top));
    if (sub.length) {
      mkdirSync(path.join(dir, SID, "subagents"), { recursive: true });
      writeFileSync(path.join(dir, SID, "subagents", "agent-1.jsonl"), jsonl(sub));
    }
    return parseSessionFile(file);
  }
  const fact = (s: Session, closing: Record<string, number[]> = {}) => computeFact(stubRepo([s], [pr77()], closing), 42, [{ ...pr77(), why: "закрыл issue" }], []);

  it("ход — один ответ модели: повтор usage того же message.id и ответы субагента другой задачи не считаются", () => {
    const file = claudeFixture(); // верхний уровень: один ответ, записанный дважды; субагент задачи — один ответ
    const subs = path.join(dir, "11111111-2222-3333-4444-555555555555", "subagents");
    writeFileSync(path.join(subs, "agent-2.jsonl"), jsonl([
      { type: "user", timestamp: at("10:09"), gitBranch: "claude/agent-9z8y7x", message: { content: "Задача #43: другое" } },
      step("10:09", "msg_other", 1000, "claude/agent-9z8y7x"),
    ]));
    const res = fact(parseSessionFile(file));
    expect(res.steps).toBe(2);
    expect(res.steps_agents).toBe(1);
  });

  it("преамбула — контекст первого хода сессии, контекст в конце — последнего; хвост — ходы с контекстом больше 400 тыс., включая субагентов", () => {
    const s = session(
      [prompt("10:00", "#42 сделай"), step("10:01", "m1", 100_000), step("10:02", "m2", 450_000), step("10:03", "m3", 500_000)],
      [{ type: "user", timestamp: at("10:02"), gitBranch: "feat/42-x", message: { content: "Задача #42: проверь" } }, step("10:02", "s1", 600_000)],
    );
    const res = fact(s);
    expect(res).toMatchObject({ steps: 4, steps_agents: 1, tail: 3, preamble: 100_010, ctx_end: 500_010 });
  });

  it("общий PR на две задачи делит токены, но не ходы — ход целый у каждой", () => {
    const res = fact(parseSessionFile(claudeFixture()), { "77": [43] });
    expect(res.shared).toEqual([{ unit: "PR #77", with: [43], k: 2 }]);
    expect(res.steps).toBe(2);
    expect(res.tok.total).toBeLessThan(6165);
  });

  it("строка «Ходы: …» в комментарии «Факт» и поля в маркере; без ответов модели строки нет", () => {
    const res = fact(parseSessionFile(claudeFixture()));
    const body = factCommentBody(res, 0.25, [], 0, null);
    expect(body).toContain("Ходы: 2 (субагентов 1, их ходов 1), преамбула 6 тыс., контекст в конце 6 тыс., ходов с контекстом > 400 тыс. — 0 %.");
    expect(parseMarker(body, "fact")).toMatchObject({ steps: 2, steps_agents: 1, tail: 0, preamble: 6100, ctx_end: 6100 });
    const bare = session([prompt("10:00", "#42 сделай"), { type: "assistant", timestamp: at("10:05"), gitBranch: "feat/42-x", message: { content: [{ type: "text", text: "без usage" }] } }]);
    const noSteps = factCommentBody(fact(bare), 0.25, [], 0, null);
    expect(noSteps).not.toContain("Ходы:");
    expect(parseMarker(noSteps, "fact").steps).toBeUndefined();
  });

  it("история показывает ходы задачи; у факта без признака — прочерк", () => {
    const row = (number: number, steps?: number): Row => ({
      item_id: "", issue_id: "", number, title: `Задача ${number}`, state: "CLOSED", stateReason: "COMPLETED", closedAt: 0, createdAt: 0, labels: [],
      est: 1, fact: 0.5, status: "Готово", est_marker: { type: "feat" }, fact_marker: { cov: "full", tok: { total: 2e6 }, usd: 1.5, agents: 0, ...(steps === undefined ? {} : { steps }) },
    });
    const lines = historyTable([row(12, 250), row(13)]);
    expect(lines[0]).toContain(" | ходы | ");
    expect(lines[1]).toMatch(/ \|\s+250 \| /);
    expect(lines[2]).toMatch(/ \|\s+— \| /);
  });
});
