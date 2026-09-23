/**
 * Скилл `est`: оценка задачи в активных часах агента по фактам похожих закрытых задач и факт при закрытии —
 * часы, токены и стоимость из транскриптов.
 *
 * Оценка «из головы» ничем не проверяема, поэтому и оценка, и факт здесь измеряются. Скрипт `est.ts` делает
 * детерминированное — читает транскрипты Claude Code и Codex, ходит в GitHub, ставит поля проекта и пишет
 * комментарии «Оценка» и «Факт»; агент выбирает аналоги и объясняет расхождения.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  branchHasIssue, branchIssueNumber, branchType, calib, computeFact, EstError, extractKeptLines, factCommentBody,
  fmtH, hashMatches, mergeIntervals, parseCodexFile, parseMarker, parseSessionFile, parseSince, plural, roundScale, usageCost,
} from "../../../skills/est/scripts/est.ts";
import type { FactRepo, PR, Row, Session } from "../../../skills/est/scripts/est.ts";
import { tmpDir } from "../../lib/spec.ts";

const EST = fileURLToPath(new URL("../../../skills/est/scripts/est.ts", import.meta.url));
const ts = (hhmm: string) => Date.parse(`2026-09-01T${hhmm}:00Z`) / 1000;
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/**
 * Оценка — ступень шкалы 0,1 · 0,25 · 0,5 · 1 · 1,5 · 2 · 3 · 5 · 8 · 13 ч: точнее по аналогам не угадать, а
 * больше 13 ч — задачу надо дробить.
 */
describe("Шкала оценки", () => {
  it("округляет к ближайшей ступени, при равном расстоянии — к меньшей, выше 13 не бывает", () => {
    expect(roundScale(2.6)).toBe(3);
    expect(roundScale(0.175)).toBe(0.1);
    expect(roundScale(0.4)).toBe(0.5);
    expect(roundScale(20)).toBe(13);
  });
});

describe("Числа и слова в выводе", () => {
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

/**
 * Стоимость — API-эквивалент по публичным тарифам: на подписке не списывается, но сравнима между задачами и
 * моделями.
 */
describe("Цены токенов", () => {
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

/** Ветка `<type>/<issue>-<slug>` привязывает работу к задаче и даёт её тип для истории оценок. */
describe("Ветка и номер задачи", () => {
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
 * Комментарии «Оценка» и «Факт» кончаются машинным маркером `<!-- est {…} -->` или `<!-- fact {…} -->`: по
 * нему скрипт находит свой комментарий и обновляет его, а не пишет новый. Строки, дописанные человеком,
 * переживают перезапись.
 */
describe("Маркеры и строки человека в комментариях", () => {
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
});

/**
 * Время — объединение интервалов активности без двойного счёта; коммит задачи узнаётся по хешу в выводе
 * инструментов, коротком или полном.
 */
describe("Интервалы и хеши", () => {
  it("пересекающиеся интервалы сливаются, короткий хеш — префикс полного", () => {
    expect(mergeIntervals([[10, 20], [15, 30], [40, 50], [5, 8]])).toEqual([[5, 8], [10, 30], [40, 50]]);
    expect(hashMatches("a1b2c3d", ["a1b2c3d4e5f6"])).toBe(true);
    expect(hashMatches("a1b2c3d4e5f6", ["a1b2c3d"])).toBe(true);
    expect(hashMatches("ffffff1", ["a1b2c3d"])).toBe(false);
  });
});

/**
 * k — отношение факт/оценка по истории: видно, сходятся ли оценки с фактами. Справочное — к прогнозу по
 * аналогам не применяется.
 */
describe("Калибровка k", () => {
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

/**
 * Из транскрипта берутся привязки к задаче — название сессии, промпты, ветка, хеши коммитов, PR — и расход
 * токенов.
 */
describe("Транскрипт Claude Code", () => {
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
});

/** У записей Codex нет ветки — привязка к задаче только по номеру в промпте и хешам коммитов. */
describe("Транскрипт Codex", () => {
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

function stubRepo(sessions: Session[], prs: PR[], closingPr: Record<string, number[]> = {}): FactRepo {
  return {
    full: "o/r",
    prs: () => new Map(prs.map((p) => [p.number, p])),
    openPrs: () => ({ at: 0, items: {} }),
    closers: () => ({ oid: {}, pr: closingPr }),
    sessions: () => sessions,
    neutralBranches: () => new Set(["main"]),
    commitDiff: () => null,
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
describe("Расчёт факта по сессиям", () => {
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

describe("Комментарий «Факт»", () => {
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

describe("CLI", () => {
  const run = (...args: string[]) => spawnSync("bun", [EST, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, AI_DEV_CONFIG_DIR: path.join(dir, "ai-dev") } });

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
