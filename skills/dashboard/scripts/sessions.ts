/**
 * Вкладка «Сессии» дашборда — задачи «В работе», их сессии Claude Code и чего каждая ждёт.
 *
 * Задача — элемент проекта GitHub со статусом «В работе», её сессия — файл закрепления `github task status`
 * (`<каталог конфигурации>/sessions/<id сессии>` со строкой `owner/repo#N`), состояние сессии — её транскрипт
 * (`~/.claude/projects/<каталог>/<id>.jsonl`), PR задачи и вопросы задач — GitHub. В GitHub ничего не пишет.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { branchIssueNumber, cloudSessionsIn, encodePath, EST_DIR, EstError, PROJECTS_DIR } from "../../est/scripts/est.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #280 записи транскрипта и ответы GitHub — JSON без схемы
type Any = any;

/** Сессия молчит, если записей нет дольше 15 мин и в фоне ничего не идёт. */
export const SILENCE = 15 * 60;
/** Фоновая задача без уведомления о завершении идёт не дольше 2 ч — потолок фоновой команды Claude Code; дальше она потеряна. */
export const BG_MAX = 2 * 3600;
/** Сессия без задачи «В работе» попадает в «Ждут владельца», если писала последние сутки. */
export const RECENT = 86400;
/** Вкладка обновляется сама: секунды. */
export const REFRESH = 30;
const IN_WORK = "В работе";

// ----------------------------------------------------------------------------
// Транскрипт
// ----------------------------------------------------------------------------

/** Фоновая задача сессии: команда, субагент или монитор; `at` — запуск, epoch-секунды. */
export interface Bg {
  id: string;
  at: number;
  what: string;
}

/** Что видно о сессии по её транскрипту. */
export interface Transcript {
  id: string;
  /** Последнее название сессии; не переименована — null. */
  title: string | null;
  /** Время последней записи с меткой времени (и записи субагентов), epoch-секунды; записей нет — null. */
  last: number | null;
  /** Фоновые задачи, запущенные без уведомления о завершении, по порядку запуска. */
  bg: Bg[];
  /** Последний ход — ответ модели без вызова инструмента: его текст; иначе null. */
  answer: string | null;
  /** Последняя запись — вызов инструмента без результата: имя инструмента; иначе null. */
  pendingTool: string | null;
  /** Сессия архивировала себя последним ходом. */
  archived: boolean;
  /** Рутина: сессию начал промпт расписания `<scheduled-task …>`, человека в ней нет. */
  routine: boolean;
}

const parse = (line: string): Any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
const tsOf = (r: Any): number | null => {
  const t = Date.parse(r?.timestamp ?? "");
  return Number.isFinite(t) ? t / 1000 : null;
};
const blocks = (r: Any): Any[] => (Array.isArray(r?.message?.content) ? r.message.content.filter((b: Any) => b && typeof b === "object") : []);
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n") : "");
const isToolResult = (r: Any) => blocks(r).some((b) => b.type === "tool_result");
const TASK_ID_RE = /<task-id>([^<\s]+)<\/task-id>/g;

/**
 * Разбор транскрипта Claude Code. Фоновая задача — результат инструмента с `backgroundTaskId` (команда), `agentId` и
 * `isAsync` (субагент) или `taskId` (Monitor); завершение — запись `<task-notification>` с тем же id или результат
 * TaskStop. Последний ход —
 * записи с конца до промпта, с которого он начался. Строки разбираются, только если в них есть нужное: транскрипт
 * бывает в десятки мегабайт, а вкладка перечитывает его каждые полминуты.
 */
export function parseTranscript(id: string, text: string): Transcript {
  const lines = text.split("\n");
  let title: string | null = null;
  let first: string | null = null; // первый промпт сессии
  const launched: (Bg & { tool: string })[] = [];
  const finished = new Set<string>();
  for (const line of lines) {
    if (first === null && line.includes('"type":"user"')) {
      const r = parse(line);
      if (r?.type === "user" && !r.isMeta && !r.isSidechain && !isToolResult(r)) first = textOf(r.message?.content);
    }
    if (line.includes('"custom-title"')) {
      const r = parse(line);
      if (r?.type === "custom-title" && r.customTitle) title = String(r.customTitle);
    } else if (line.includes("<task-notification>")) {
      const r = parse(line);
      // уведомление — промпт сессии или ещё в очереди к ней; текст инструмента, где оно лишь упомянуто, — нет
      const body = r?.type === "user" ? textOf(r.message?.content) : r?.type === "queue-operation" ? String(r.content ?? "") : "";
      if (body.trimStart().startsWith("<task-notification>")) for (const m of body.matchAll(TASK_ID_RE)) finished.add(m[1]!);
    } else if (line.includes("Successfully stopped task")) {
      // остановленная TaskStop фоновая задача уведомления не шлёт: завершение — результат остановки
      const u = parse(line)?.toolUseResult;
      const task = u?.task_id ?? u?.shell_id;
      if (typeof task === "string" && /^Successfully stopped task/.test(String(u.message ?? ""))) finished.add(task);
    } else if (line.includes('"toolUseResult"') && /"(backgroundTaskId|agentId|taskId)"/.test(line)) {
      const r = parse(line);
      const u = r?.type === "user" ? r.toolUseResult : null;
      const task = u?.backgroundTaskId ?? (u?.isAsync ? u.agentId : null) ?? u?.taskId;
      const at = tsOf(r);
      const tool = blocks(r).find((b) => b.type === "tool_result")?.tool_use_id;
      if (typeof task === "string" && at !== null) launched.push({ id: task, at, what: String(u.description ?? ""), tool: String(tool ?? "") });
    }
  }
  // что делает фоновая задача — описание её вызова
  const want = new Set(launched.filter((b) => b.tool).map((b) => b.tool));
  const what = new Map<string, string>();
  if (want.size)
    for (const line of lines) {
      if (!line.includes('"tool_use"') || ![...want].some((t) => line.includes(t))) continue;
      for (const b of blocks(parse(line))) if (b.type === "tool_use" && want.has(b.id)) what.set(b.id, String(b.input?.description || b.input?.command || b.name));
    }
  const bg = launched.filter((b) => !finished.has(b.id)).map((b) => ({ id: b.id, at: b.at, what: what.get(b.tool) || b.what || "фоновая задача" }));

  let last: number | null = null;
  const turn: Any[] = []; // записи последнего хода, с конца
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line || (last !== null && !line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    const r = parse(line);
    if (!r) continue;
    last ??= tsOf(r);
    if ((r.type !== "user" && r.type !== "assistant") || r.isSidechain) continue;
    turn.push(r);
    // ход начинается промптом: человек или уведомление; служебная вставка (isMeta) и результат инструмента — внутри хода
    if (r.type === "user" && !isToolResult(r) && !r.isMeta) break;
  }

  let answer: string | null = null;
  let pendingTool: string | null = null;
  const end = turn[0];
  if (end?.type === "assistant") {
    const calls = blocks(end).filter((b) => b.type === "tool_use");
    if (calls.length) pendingTool = String(calls[calls.length - 1].name);
    else if (end.message?.stop_reason !== "tool_use") {
      // ответ — текст всех записей последнего сообщения модели: приложение пишет блоки сообщения по записи на блок
      const texts: string[] = [];
      for (const r of turn) {
        if (r.type !== "assistant" || r.message?.id !== end.message?.id) break;
        texts.unshift(...blocks(r).filter((b) => b.type === "text").map((b) => String(b.text ?? "")));
      }
      answer = texts.join("\n\n").trim();
    }
  } else if (end?.type === "user" && /^\[Request interrupted by user/.test(textOf(end.message?.content))) answer = "ход прерван человеком";
  const archived = turn.some((r) => r.type === "assistant" && blocks(r).some((b) => b.type === "tool_use" && /archive_session$/.test(String(b.name)) && b.input?.session_id === "self"));
  return { id, title, last, bg, answer, pendingTool, archived, routine: (first ?? "").trimStart().startsWith("<scheduled-task") };
}

// ----------------------------------------------------------------------------
// Вопросы
// ----------------------------------------------------------------------------

// строки конца сессии по канону (AGENTS.md, «Актуализация блока при закрытии задачи»), в том числе с разметкой
const ASK_RE = /^[\s*_>]*(Всё сделано, но есть вопросы|Осталось)/;
const DONE_RE = /Сессию можно закрывать\.?[\s*_]*$/;

/**
 * Вопрос владельцу в ответе сессии: от строки «Всё сделано, но есть вопросы…» или «Осталось: …» до конца ответа; без
 * них — последний абзац. «Всё сделано. Сессию можно закрывать.» — не вопрос: null. `strict` — для сессии без задачи
 * «В работе»: её последний ответ часто просто ответ, и без этих строк вопрос — только абзац, кончающийся «?».
 */
export function questionOf(answer: string, strict = false): string | null {
  const text = answer.trim();
  const lines = text.split("\n");
  const i = lines.findIndex((l) => ASK_RE.test(l));
  if (i >= 0) return lines.slice(i).join("\n").trim();
  if (DONE_RE.test(text)) return null;
  const paras = text.split(/\n\s*\n/);
  const last = paras[paras.length - 1]!.trim();
  return strict && !/\?[\s*_)»"]*$/.test(last) ? null : last;
}

/** Открытые вопросы задачи — первые строки пунктов раздела «## Вопросы» без ✅. */
export function openQuestions(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const from = lines.findIndex((l) => /^##\s+Вопросы\s*$/.test(l));
  if (from < 0) return [];
  const items: string[][] = [];
  for (const line of lines.slice(from + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\d+\.\s/.test(line)) items.push([line]);
    else if (items.length && line.trim()) items[items.length - 1]!.push(line);
  }
  return items.filter((it) => !it.some((l) => l.includes("✅"))).map((it) => it[0]!.trim());
}

// ----------------------------------------------------------------------------
// Чего ждёт сессия
// ----------------------------------------------------------------------------

/** Состояние чеков: идут, красные, зелёные; чеков нет — null. */
export type Checks = "pending" | "failure" | "success" | null;

/** PR задачи: открытый или влитый, его чеки и конфликт; `deploy` — чеки коммита мержа. */
export interface PrInfo {
  number: number;
  url: string;
  branch: string;
  /** Задачи, которые PR закрывает (`Closes #N`). */
  closes: number[];
  merged: boolean;
  checks: Checks;
  conflict: boolean;
  deploy: Checks;
  /** В коммитах — трейлер облачной сессии `Claude-Session`. */
  cloud: boolean;
}

export type WaitKey = "human" | "merge" | "silent" | "ci-red" | "ci" | "deploy" | "working" | "done" | "none" | "cloud";

export interface Wait {
  key: WaitKey;
  label: string;
  detail: string;
}

const LABEL: Record<WaitKey, string> = {
  human: "ответ человека",
  merge: "мерж",
  silent: "тишина",
  "ci-red": "CI красный",
  ci: "CI идёт",
  deploy: "деплой",
  working: "работает",
  done: "можно закрывать",
  none: "сессии нет",
  cloud: "облако, состояние не видно",
};

/**
 * Чего ждёт сессия задачи. Идущая фоновая задача будит сессию сама — она главнее ответа: что она ждёт, видно по PR
 * (открыт и чеки идут — CI, влит и идут чеки коммита мержа — деплой). Ответ модели без вызова инструмента — ход за
 * человеком; PR при этом зелёный и вливается — ждёт мержа. Ни того, ни другого, а записей нет дольше порога — тишина.
 */
export function waitOf(s: Transcript | null, pr: PrInfo | null, now: number): Wait {
  const w = (key: WaitKey, detail = ""): Wait => ({ key, label: LABEL[key], detail });
  // облачная сессия задачу не закрепляет: проекты GitHub ей закрыты, её состояние отсюда не видно
  if (!s) return pr?.cloud ? w("cloud") : w("none");
  if (s.archived) return w("done", "сессия архивирована");
  const bg = s.bg.filter((b) => now - b.at <= BG_MAX);
  if (bg.length) {
    const what = `в фоне: ${bg.map((b) => b.what).join("; ")}`;
    if (pr && !pr.merged && pr.checks === "pending") return w("ci", what);
    if (pr && !pr.merged && pr.checks === "failure") return w("ci-red", what);
    if (pr?.merged && pr.deploy === "pending") return w("deploy", what);
    return w("working", what);
  }
  if (s.answer !== null) {
    const q = questionOf(s.answer);
    if (q === null) return w("done");
    const first = q.split("\n")[0]!;
    return pr && !pr.merged && pr.checks === "success" && !pr.conflict ? w("merge", first) : w("human", first);
  }
  if (s.last === null || now - s.last > SILENCE) return w("silent", s.pendingTool ? `вызов ${s.pendingTool} без результата — ждёт разрешения или завис` : "записей нет, в фоне ничего");
  return w("working");
}

// ----------------------------------------------------------------------------
// Вкладка
// ----------------------------------------------------------------------------

/** Задача «В работе» и её эпик. */
export interface Task {
  number: number;
  title: string;
  parent: { number: number; title: string } | null;
}

/** Что GitHub знает о репозитории: задачи «В работе» (без эпиков), PR, задачи с открытыми вопросами. */
export interface Live {
  tasks: Task[];
  prs: PrInfo[];
  questions: { number: number; title: string; body: string }[];
}

export interface SessionsInput {
  /** Закрепления: `owner/repo#N` → id сессий. */
  pins: Record<string, string[]>;
  /** Транскрипты закреплённых сессий по id. */
  transcripts: Record<string, Transcript>;
  /** GitHub по репозиториям. */
  live: Record<string, Live>;
  /** Недавние сессии каталогов репозитория — их вопросы, если задачи «В работе» у них нет. */
  others: Record<string, Transcript[]>;
}

export interface SessionRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  epic: { number: number; title: string; url: string } | null;
  session: Transcript | null;
  pr: PrInfo | null;
  wait: Wait;
}

/** Вопрос владельцу: задачи (ответ её сессии), сессии без задачи «В работе» или задачи с меткой «вопросы». */
export interface Ask {
  /** `issue` — задача «В работе» с меткой «вопросы», `backlog` — остальные задачи с меткой. */
  kind: "task" | "session" | "issue" | "backlog";
  repo: string;
  head: string;
  url: string | null;
  session: Transcript | null;
  lines: string[];
}

export interface SessionsView {
  rows: SessionRow[];
  asks: Ask[];
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const OWNER = new Set<WaitKey>(["human", "merge"]);
// сверху — ждущие владельца, затем молчащие и красные: на них смотрят первыми
const RANK: Partial<Record<WaitKey, number>> = { human: 0, merge: 0, silent: 1, "ci-red": 1 };

/** PR задачи: открытый, иначе последний влитый; связь — `Closes #N` или ветка `<type>/<N>-…`. */
function prFor(live: Live, n: number): PrInfo | null {
  const mine = live.prs.filter((p) => p.closes.includes(n) || branchIssueNumber(p.branch) === n);
  return mine.find((p) => !p.merged) ?? mine[0] ?? null;
}

/** Строки задач «В работе» и вопросы владельцу. */
export function sessionsView(inp: SessionsInput, now: number): SessionsView {
  const pinned = new Set<string>();
  const rows: SessionRow[] = Object.entries(inp.live).flatMap(([repo, live]) =>
    live.tasks.map((t) => {
      const ids = inp.pins[`${repo}#${t.number}`] ?? [];
      ids.forEach((id) => pinned.add(id));
      // после /clear у задачи новая сессия, старое закрепление остаётся: берётся писавшая последней
      const session = ids.map((id) => inp.transcripts[id]).filter((s): s is Transcript => !!s).sort((a, b) => (b.last ?? 0) - (a.last ?? 0))[0] ?? null;
      const pr = prFor(live, t.number);
      return {
        repo, number: t.number, title: t.title, url: issueUrl(repo, t.number), session, pr, wait: waitOf(session, pr, now),
        epic: t.parent ? { ...t.parent, url: issueUrl(repo, t.parent.number) } : null,
      };
    }),
  );
  rows.sort((a, b) => (RANK[a.wait.key] ?? 2) - (RANK[b.wait.key] ?? 2) || a.repo.localeCompare(b.repo) || a.number - b.number);

  const asks: Ask[] = rows.filter((r) => OWNER.has(r.wait.key)).map((r) => ({ kind: "task", repo: r.repo, head: `#${r.number} ${r.title}`, url: r.url, session: r.session, lines: questionOf(r.session!.answer ?? "")!.split("\n") }));
  for (const [repo, list] of Object.entries(inp.others)) {
    // рутина и ответ без явного вопроса — не к владельцу: иначе блок тонет в отчётах по расписанию
    const recent = list.flatMap((s) => {
      const q = !pinned.has(s.id) && !s.routine && s.last !== null && now - s.last <= RECENT && waitOf(s, null, now).key === "human" ? questionOf(s.answer!, true) : null;
      return q === null ? [] : [{ s, q }];
    });
    for (const { s, q } of recent.sort((a, b) => b.s.last! - a.s.last!)) asks.push({ kind: "session", repo, head: s.title ?? `сессия ${s.id.slice(0, 8)}`, url: null, session: s, lines: q.split("\n") });
  }
  const issues = Object.entries(inp.live).flatMap(([repo, live]) =>
    live.questions.map((q): Ask => {
      const inWork = live.tasks.some((t) => t.number === q.number);
      return { kind: inWork ? "issue" : "backlog", repo, head: `#${q.number} ${q.title}`, url: issueUrl(repo, q.number), session: null, lines: openQuestions(q.body) };
    }),
  );
  asks.push(...issues.filter((a) => a.kind === "issue"), ...issues.filter((a) => a.kind === "backlog"));
  return { rows, asks };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const link = (url: string, text: string) => `<a href="${esc(url)}">${esc(text)}</a>`;

/** Сколько прошло: «4 мин назад», «2 ч 5 мин назад», «3 д назад». */
function ago(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ""} назад`;
  return `${Math.floor(h / 24)} д назад`;
}

const when = (s: Transcript, now: number) => (s.last === null ? "записей нет" : ago(now - s.last));
/** Название сессии, если оно не повторяет задачу: по канону сессия называется «#N <название задачи>». */
const ownTitle = (s: Transcript, task: string) => (s.title === null ? `без названия, ${s.id.slice(0, 8)}` : s.title === task ? null : s.title);
const CHECKS: Record<string, string> = { pending: "чеки идут", failure: "чеки красные", success: "чеки зелёные", null: "чеков нет" };
const DEPLOY: Record<string, string> = { pending: " · деплой идёт", failure: " · деплой красный", success: "", null: "" };

function prCell(p: PrInfo | null): string {
  if (!p) return "—";
  const state = p.merged ? `влит${DEPLOY[String(p.deploy)]}` : `${CHECKS[String(p.checks)]}${p.conflict ? " · конфликт" : ""}`;
  return `${link(p.url, `#${p.number}`)} ${esc(state)}`;
}

function asksBlock(asks: Ask[], now: number, many: boolean): string {
  const item = (a: Ask) => {
    const head = `${many ? a.repo : ""}${a.head}`;
    const top = (sub: string) => `<div class="ask-head">${a.url ? link(a.url, head) : esc(head)} <span class="minor">${esc(sub)}</span></div>`;
    const text = (lines: string[]) => `<div class="ask-text">${lines.map(esc).join("<br>")}</div>`;
    // задач с вопросами десятки: строкой, сами вопросы — под раскрытием
    if (a.kind === "issue" || a.kind === "backlog")
      return `<li>${top(a.lines.length ? `метка «вопросы» · открытых: ${a.lines.length}` : "метка «вопросы»")}${a.lines.length ? `<details data-key="${esc(`${a.repo}${a.head}`)}"><summary>вопросы</summary>${text(a.lines)}</details>` : ""}</li>`;
    const name = a.kind === "task" ? ownTitle(a.session!, a.head) : null;
    return `<li>${top(a.kind === "task" ? `сессия${name ? ` «${name}»` : ""} · ${when(a.session!, now)}` : `сессия без задачи «В работе» · ${when(a.session!, now)}`)}${text(a.lines)}</li>`;
  };
  const live = asks.filter((a) => a.kind !== "backlog");
  const backlog = asks.filter((a) => a.kind === "backlog");
  // вопросы бэклога ждут, пока задачу не возьмут: свёрнуты, чтобы не заслонять сессии, которые стоят сейчас
  const rest = backlog.length ? `<details class="backlog" data-key="backlog"><summary>задачи с вопросами вне работы: ${backlog.length}</summary><ul>${backlog.map(item).join("")}</ul></details>` : "";
  return `<section class="asks card"><h2>Ждут владельца</h2>${live.length ? `<ul>${live.map(item).join("")}</ul>` : `<p class="note">вопросов нет</p>`}${rest}</section>`;
}

function rowsTable(rows: SessionRow[], now: number, many: boolean): string {
  if (!rows.length) return `<p class="card">Задач «В работе» нет.</p>`;
  const body = rows.map((r) => {
    const task = `${link(r.url, `${many ? r.repo : ""}#${r.number}`)} ${esc(r.title)}${r.epic ? `<div class="minor">эпик ${link(r.epic.url, `#${r.epic.number} ${r.epic.title}`)}</div>` : ""}`;
    const name = r.session && ownTitle(r.session, `#${r.number} ${r.title}`);
    const session = r.session ? `${esc(when(r.session, now))}${name ? `<div class="minor">${esc(name)}</div>` : ""}` : "—";
    const wait = `<span class="wait ${r.wait.key}">${esc(r.wait.label)}</span>${r.wait.detail ? `<div class="minor">${esc(r.wait.detail)}</div>` : ""}`;
    return `<tr data-task="${esc(`${r.repo}#${r.number}`)}"><td>${task}</td><td>${session}</td><td>${wait}</td><td>${prCell(r.pr)}</td></tr>`;
  });
  return `<section class="card scroll"><table class="sessions"><thead><tr><th>Задача</th><th>Сессия</th><th>Ждёт</th><th>PR</th></tr></thead><tbody>${body.join("")}</tbody></table></section>`;
}

/** Содержимое вкладки: «Ждут владельца» сверху, под ним — строка на задачу «В работе». */
export function sessionsBody(v: SessionsView, now: number, many: boolean): string {
  return asksBlock(v.asks, now, many) + rowsTable(v.rows, now, many);
}

/**
 * Самообновление вкладки: раз в `sec` секунд и при возврате на вкладку — страница заново и подмена `<main>`, раскрытое
 * остаётся раскрытым; скрытая вкладка не обновляется. Перезагрузка (meta refresh) сворачивала бы раскрытые вопросы
 * каждые полминуты.
 */
export function refreshScript(sec: number): string {
  return `<script>async function refreshMain() {
  let html;
  try { const r = await fetch(location.href, { cache: "no-store" }); if (!r.ok) return; html = await r.text(); } catch { return; }
  const next = new DOMParser().parseFromString(html, "text/html").querySelector("main"); if (!next) return;
  const open = new Set([...document.querySelectorAll("details[open][data-key]")].map((d) => d.dataset.key));
  document.querySelector("main").replaceWith(next);
  next.querySelectorAll("details[data-key]").forEach((d) => { if (open.has(d.dataset.key)) d.open = true; });
}
setInterval(() => document.hidden || refreshMain(), ${sec * 1000});
document.addEventListener("visibilitychange", () => document.hidden || refreshMain());</script>`;
}

/** Стили вкладки; цвета — переменные темы страницы. */
export const SESSIONS_CSS = `
h2{font-size:16px;margin:0 0 8px}
.asks ul{list-style:none;margin:0;padding:0}
.asks li{padding:8px 0;border-top:1px solid var(--grid)}
.asks li:first-child{border-top:0;padding-top:0}
.ask-head{font-weight:600}.ask-head .minor{font-weight:400}
.ask-text{margin-top:2px;white-space:pre-wrap}
.asks details{margin-top:2px}.asks summary{cursor:pointer;color:var(--ink2);font-size:13px}
.asks details.backlog{margin-top:8px}.asks details.backlog>summary{font-size:14px}.asks details.backlog ul{margin-top:8px}
.minor{color:var(--ink2);font-size:13px}
table.sessions td{text-align:left;white-space:normal;vertical-align:top}
table.sessions td:nth-child(1){min-width:220px}
table.sessions td:nth-child(2){min-width:0;white-space:nowrap}
table.sessions td:nth-child(3){min-width:160px}
table.sessions th{text-align:left}
.wait{display:inline-block;padding:1px 8px;border-radius:999px;font-size:13px;border:1px solid var(--border);white-space:nowrap}
.wait.human,.wait.merge{background:var(--warn);color:#000;border-color:transparent}
.wait.silent,.wait.ci-red{background:var(--bad);color:#fff;border-color:transparent}
.wait.ci,.wait.deploy,.wait.working{color:var(--fact)}
.wait.done{color:var(--good)}
.wait.none,.wait.cloud{color:var(--muted)}
`;

// ----------------------------------------------------------------------------
// Чтение: закрепления, транскрипты, GitHub
// ----------------------------------------------------------------------------

/** Закрепления задач за сессиями: `owner/repo#N` → id сессий (файлы `sessions/<id>` каталога конфигурации). */
export function readPins(dir = path.join(EST_DIR, "sessions")): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const id of names) {
    if (id.startsWith(".")) continue;
    let task: string;
    try {
      task = readFileSync(path.join(dir, id), "utf8").trim();
    } catch {
      continue;
    }
    if (task) (out[task] ??= []).push(id);
  }
  return out;
}

const parsed = new Map<string, { key: string; t: Transcript }>();

/** Транскрипт файла; разбирается заново, только если файл изменился. Записи субагентов — тоже признак жизни сессии. */
function readTranscript(file: string): Transcript {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  let t = parsed.get(file)?.key === key ? parsed.get(file)!.t : null;
  if (!t) {
    t = parseTranscript(path.basename(file, ".jsonl"), readFileSync(file, "utf8"));
    parsed.set(file, { key, t });
  }
  // субагент пишет в свой транскрипт (<id>/subagents/), а сессия ждёт его без записей
  const sub = path.join(file.slice(0, -".jsonl".length), "subagents");
  let subAt = 0;
  try {
    for (const f of readdirSync(sub)) subAt = Math.max(subAt, statSync(path.join(sub, f)).mtimeMs / 1000);
  } catch {
    // субагентов нет
  }
  return subAt > (t.last ?? 0) ? { ...t, last: subAt } : t;
}

/** Файлы транскриптов `<каталог>/<имя>.jsonl` каталогов `projectsDir`, подходящих под `match`. */
function transcriptFiles(match: (dir: string, name: string) => boolean, projectsDir: string): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith(".jsonl") && match(d, n)) out.push(path.join(projectsDir, d, n));
  }
  return out;
}

/** Транскрипты сессий по id — в каталоге любого проекта: сессия работает и из чужого каталога. */
export function findTranscripts(ids: string[], projectsDir = PROJECTS_DIR): Record<string, Transcript> {
  const want = new Set(ids.map((id) => `${id}.jsonl`));
  const out: Record<string, Transcript> = {};
  if (!want.size) return out;
  for (const f of transcriptFiles((_, n) => want.has(n), projectsDir)) {
    const t = readTranscript(f);
    // один id в двух каталогах (приложение перенесло транскрипт) — свежий
    if ((t.last ?? 0) >= (out[t.id]?.last ?? 0)) out[t.id] = t;
  }
  return out;
}

/** Транскрипты каталогов репозитория (`paths` реестра est и их worktree), изменённые не раньше `since`. */
export function repoTranscripts(paths: string[], since: number, projectsDir = PROJECTS_DIR): Transcript[] {
  const encs = paths.map(encodePath);
  if (!encs.length) return [];
  const files = transcriptFiles((d) => encs.some((e) => d.startsWith(e)), projectsDir);
  return files.filter((f) => statSync(f).mtimeMs / 1000 >= since).map(readTranscript);
}

const ROLLUP: Record<string, Checks> = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };
const rollup = (state: unknown): Checks => ROLLUP[String(state)] ?? null;
const isEpic = (i: Any) => (i.labels?.nodes ?? []).some((l: Any) => l.name === "epic") || ["эпик", "epic"].includes(String(i.issueType?.name ?? "").toLowerCase());
const PR_FIELDS = "number url headRefName mergeable closingIssuesReferences(first:10){nodes{number}} commits(last:20){nodes{commit{messageBody statusCheckRollup{state}}}}";

/** Задачи «В работе», PR и задачи с меткой «вопросы» из ответа GitHub; эпик — не строка: его сессия планирует, а не делает. */
function packLive(data: Any): Live {
  const pack = (p: Any, merged: boolean): PrInfo => {
    const commits: Any[] = p.commits?.nodes ?? [];
    return {
      number: p.number, url: p.url, branch: p.headRefName ?? "", closes: (p.closingIssuesReferences?.nodes ?? []).map((n: Any) => n.number), merged,
      checks: rollup(commits[commits.length - 1]?.commit?.statusCheckRollup?.state), conflict: p.mergeable === "CONFLICTING",
      deploy: merged ? rollup(p.mergeCommit?.statusCheckRollup?.state) : null, cloud: commits.some((c) => cloudSessionsIn(c.commit?.messageBody ?? "").length > 0),
    };
  };
  const issues = (data?.project?.items?.nodes ?? []).map((it: Any) => it?.content).filter((c: Any) => c?.__typename === "Issue" && c.state === "OPEN" && !isEpic(c));
  const repo = data?.repository;
  return {
    tasks: issues.map((c: Any) => ({ number: c.number, title: c.title, parent: c.parent ? { number: c.parent.number, title: c.parent.title } : null })).sort((a: Task, b: Task) => a.number - b.number),
    prs: [...(repo?.open?.nodes ?? []).map((p: Any) => pack(p, false)), ...(repo?.merged?.nodes ?? []).map((p: Any) => pack(p, true))],
    questions: (repo?.questions?.nodes ?? []).map((q: Any) => ({ number: q.number, title: q.title, body: q.body ?? "" })),
  };
}

/** `gh api graphql` без блокировки сервера: вкладка отвечает из кэша, пока GitHub собирает свежее. */
function graphql(query: string, variables: Record<string, unknown>): Promise<Any> {
  return new Promise((resolve, reject) => {
    const p = spawn("gh", ["api", "graphql", "--input", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new EstError((e as NodeJS.ErrnoException).code === "ENOENT" ? "не найдена команда 'gh'; нужен установленный gh CLI" : `gh api graphql: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) return reject(new EstError(`команда gh api graphql… завершилась с кодом ${code}: ${err.trim().slice(0, 500)}`));
      let data: Any;
      try {
        data = JSON.parse(out);
      } catch {
        return reject(new EstError(`gh api graphql: ответ не JSON: ${out.slice(0, 200)}`));
      }
      // частичный ответ (нет доступа к одной задаче) — данные есть, их и берём
      if (data.errors?.length && !data.data) return reject(new EstError(`GraphQL: ${data.errors.map((e: Any) => e.message ?? "").join("; ")}`));
      resolve(data.data);
    });
    p.stdin.end(JSON.stringify({ query, variables }));
  });
}

/**
 * Один запрос на репозиторий: задачи «В работе» с эпиком — фильтром проекта на стороне GitHub (строки проекта целиком,
 * с комментариями, как у вкладки «Оценка и факт», идут десятки секунд), открытые и недавно влитые PR, задачи с меткой
 * «вопросы».
 */
export async function liveQuery(full: string, projectId: string): Promise<Live> {
  // облачной сессии Projects v2 закрыты; dashboard выходит раньше, здесь — для вызова в обход него
  if (process.env.CLAUDE_CODE_REMOTE === "true") throw new EstError("облачная сессия Claude Code: проекты GitHub отсюда недоступны (docs/cloud-sessions.md в ai-dev)");
  const [o, r] = full.split("/");
  const q = `query($o:String!,$r:String!,$p:ID!,$q:String!){
    project: node(id:$p){ ... on ProjectV2{ items(first:100, query:$q){ nodes{ content{ __typename
      ... on Issue{ number title state issueType{name} labels(first:15){nodes{name}} parent{ number title } } } } } } }
    repository(owner:$o,name:$r){
      open: pullRequests(states:OPEN, first:50, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PR_FIELDS} } }
      merged: pullRequests(states:MERGED, first:30, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PR_FIELDS} mergeCommit{ statusCheckRollup{state} } } }
      questions: issues(states:OPEN, labels:["вопросы"], first:50){ nodes{ number title body } } } }`;
  return packLive(await graphql(q, { o, r, p: projectId, q: `status:"${IN_WORK}"` }));
}
