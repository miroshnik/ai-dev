/**
 * The dashboard's "Sessions" tab — "In progress" tasks, their Claude Code sessions and what each one waits for.
 *
 * A task is a GitHub project item with the "In progress" status, its session is the `github task status` pin file
 * (`<configuration directory>/sessions/<session id>` with an `owner/repo#N` line), the session's state is its
 * transcript (`~/.claude/projects/<directory>/<id>.jsonl`), the task's PR and the tasks' questions come from GitHub, the
 * addresses of its services — from the routes of the task-env proxy. Writes nothing to GitHub.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { questionItems } from "../../github/scripts/github.ts";
import locale from "../../github/scripts/locale.ts";
import { branchIssueNumber, cloudSessionsIn, encodePath, EST_DIR, EstError, PROJECTS_DIR } from "../../est/scripts/est.ts";
import { addressUrl, hostProject, taskAddress } from "../../task-env/scripts/task-env.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #280 schemaless JSON from transcripts and GitHub
type Any = any;

/** A session is silent if it has had no records for more than 15 min and nothing runs in the background. */
export const SILENCE = 15 * 60;
/**
 * A background task without a completion notification runs no longer than 2 h — the Claude Code background command
 * cap; after that it is lost.
 */
export const BG_MAX = 2 * 3600;
/** A session without an "In progress" task gets into "Waiting for the owner" if it wrote within the last day. */
export const RECENT = 86400;
/** "Decided auto" — answers of tasks whose description changed within the last day. */
export const AUTO_WINDOW = 86400;
/** The tab refreshes itself: seconds. */
export const REFRESH = 30;
/**
 * The dashboard is shared by all repositories of the machine: labels are in English, and the names it parses (the
 * "In progress" status, the questions section and label, the session's last line) — in any language of the github
 * skill's locales dictionary.
 */
const IN_WORK = locale.every((n) => n.status.inProgress);

// ----------------------------------------------------------------------------
// Transcript
// ----------------------------------------------------------------------------

/** A session's background task: a command, a subagent or a monitor; `at` — the start, epoch seconds. */
export interface Bg {
  id: string;
  at: number;
  what: string;
}

/** What the session's transcript tells about it. */
export interface Transcript {
  id: string;
  /** The session's latest name; not renamed — null. */
  title: string | null;
  /** Time of the last record with a timestamp (and of subagent records), epoch seconds; no records — null. */
  last: number | null;
  /** Background tasks started without a completion notification, in start order. */
  bg: Bg[];
  /** The last turn is a model answer without a tool call: its text; otherwise null. */
  answer: string | null;
  /** The last record is a tool call without a result: the tool's name; otherwise null. */
  pendingTool: string | null;
  /** The session archived itself with its last turn. */
  archived: boolean;
  /** A routine: the session was started by a schedule prompt `<scheduled-task …>`, there's no human in it. */
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
 * Parsing a Claude Code transcript. A background task is a tool result with `backgroundTaskId` (a command), `agentId`
 * and `isAsync` (a subagent) or `taskId` (Monitor); its completion is a `<task-notification>` record with the same id
 * or a TaskStop result. The last turn is the records from the end back to the prompt it started with. Lines are parsed
 * only if they contain what's needed: a transcript can be tens of megabytes, and the tab re-reads it every half
 * minute.
 */
export function parseTranscript(id: string, text: string): Transcript {
  const lines = text.split("\n");
  let title: string | null = null;
  let first: string | null = null; // the session's first prompt
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
      // a notification is a session prompt or one still queued for it; a tool's text that merely mentions it is not
      const body = r?.type === "user" ? textOf(r.message?.content) : r?.type === "queue-operation" ? String(r.content ?? "") : "";
      if (body.trimStart().startsWith("<task-notification>")) for (const m of body.matchAll(TASK_ID_RE)) finished.add(m[1]!);
    } else if (line.includes("Successfully stopped task")) {
      // a background task stopped by TaskStop sends no notification: its completion is the stop's result
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
  // what a background task does — the description of its call
  const want = new Set(launched.filter((b) => b.tool).map((b) => b.tool));
  const what = new Map<string, string>();
  if (want.size)
    for (const line of lines) {
      if (!line.includes('"tool_use"') || ![...want].some((t) => line.includes(t))) continue;
      for (const b of blocks(parse(line))) if (b.type === "tool_use" && want.has(b.id)) what.set(b.id, String(b.input?.description || b.input?.command || b.name));
    }
  const bg = launched.filter((b) => !finished.has(b.id)).map((b) => ({ id: b.id, at: b.at, what: what.get(b.tool) || b.what || "background task" }));

  let last: number | null = null;
  const turn: Any[] = []; // records of the last turn, from the end
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line || (last !== null && !line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    const r = parse(line);
    if (!r) continue;
    last ??= tsOf(r);
    if ((r.type !== "user" && r.type !== "assistant") || r.isSidechain) continue;
    turn.push(r);
    // a turn starts with a prompt: a human's or a notification; a meta insert (isMeta) and a tool result are inside it
    if (r.type === "user" && !isToolResult(r) && !r.isMeta) break;
  }

  let answer: string | null = null;
  let pendingTool: string | null = null;
  const end = turn[0];
  if (end?.type === "assistant") {
    const calls = blocks(end).filter((b) => b.type === "tool_use");
    if (calls.length) pendingTool = String(calls[calls.length - 1].name);
    else if (end.message?.stop_reason !== "tool_use") {
      // the answer is the text of all records of the model's last message: the app writes a message's blocks one record
      // per block
      const texts: string[] = [];
      for (const r of turn) {
        if (r.type !== "assistant" || r.message?.id !== end.message?.id) break;
        texts.unshift(...blocks(r).filter((b) => b.type === "text").map((b) => String(b.text ?? "")));
      }
      answer = texts.join("\n\n").trim();
    }
  } else if (end?.type === "user" && /^\[Request interrupted by user/.test(textOf(end.message?.content))) answer = "turn interrupted by a human";
  const archived = turn.some((r) => r.type === "assistant" && blocks(r).some((b) => b.type === "tool_use" && /archive_session$/.test(String(b.name)) && b.input?.session_id === "self"));
  return { id, title, last, bg, answer, pendingTool, archived, routine: (first ?? "").trimStart().startsWith("<scheduled-task") };
}

// ----------------------------------------------------------------------------
// Questions
// ----------------------------------------------------------------------------

// session end lines per the canon (AGENTS.md, "Epic refresh on task close") in any language of the dictionary,
// markup included
const alt = (xs: string[]) => xs.map((x) => locale.escapeRe(x.replace(/[:.]$/, ""))).join("|");
const ASK_RE = new RegExp(`^[\\s*_>]*(?:${alt([...locale.every((n) => n.lastLine.questions), ...locale.every((n) => n.lastLine.remaining)])})`);
const DONE_RE = new RegExp(`(?:${alt(locale.every((n) => n.lastLine.done))})\\.?\\s*$`);

/**
 * A question to the owner in the session's answer: from the line "All done, but there are questions…" or
 * "Remaining: …" to the end of the answer; without them — the last paragraph. "All done. The session can be closed."
 * isn't a question: null. `strict` — for a session without an "In progress" task: its last answer is often just an
 * answer, and without these lines a question is only a paragraph that ends with "?".
 */
export function questionOf(answer: string, strict = false): string | null {
  const text = answer.trim();
  const lines = text.split("\n");
  const i = lines.findIndex((l) => ASK_RE.test(l));
  if (i >= 0) return lines.slice(i).join("\n").trim();
  if (DONE_RE.test(text.replace(/[*_]/g, ""))) return null;
  const paras = text.split(/\n\s*\n/);
  const last = paras[paras.length - 1]!.trim();
  return strict && !/\?[\s*_)»"]*$/.test(last) ? null : last;
}

/**
 * A task's open questions — the first lines of the items of the questions section ("## Questions" in any language of
 * the dictionary) without ✅; the section is parsed by the github skill, as `task actualize` parses it.
 */
export function openQuestions(body: string): string[] {
  return questionItems(body).filter((x) => !x.answered).map((x) => x.text);
}

/** A question the session answered itself in auto mode, and its answer. */
export interface AutoAnswer {
  question: string;
  answer: string;
}

/**
 * The auto-answer mark — `autoAnswer` of any language of the dictionary, with markup around it: `task answer --auto`
 * puts it before the question, by hand it was put after the question and on a continuation line, and «✅ auto» in a
 * project of another language too.
 */
const AUTO_RE = new RegExp(`[*_]*(?:${alt(locale.every((n) => n.autoAnswer)).replace(/ /g, "\\s*")})(?![\\p{L}\\p{N}])[*_:.]*`, "iu");
/** The end of a question: "?" at the end of a word, closing markup included. */
const QMARK_RE = /\?[»"'*_)]*(?=\s|$)/;
/** A bold label before the answer — `**Answer:**` of the `task answer` format, `**Decision:**` by hand. */
const LABEL_RE = /\*\*[^*\n]{1,40}:\*\*/g;

/** A dash between the question and the answer: «Question? — answer». */
const dashes = { start: /^[\s—–]+/, end: /[\s—–]+$/ };

/**
 * The question and the answer of an item text with the mark at its start or end: before a bold label, otherwise up to
 * the first "?", otherwise the first line is the question, and a single line — up to the first « — ».
 */
function splitAnswer(text: string): AutoAnswer {
  const cut = (at: number, skip: number) => ({ question: text.slice(0, at).replace(dashes.end, ""), answer: text.slice(at + skip).replace(dashes.start, "") });
  const label = [...text.matchAll(LABEL_RE)].find((l) => text.slice(0, l.index).trim());
  if (label) return cut(label.index, label[0].length);
  const q = QMARK_RE.exec(text);
  if (q) return cut(q.index + q[0].length, 0);
  const nl = text.indexOf("\n");
  if (nl >= 0) return cut(nl, 1);
  const dash = text.indexOf(" — ");
  return dash > 0 ? cut(dash, 3) : { question: text, answer: "" };
}

/**
 * Answers marked `autoAnswer` in the questions section. The mark between text is itself the separator: before it is
 * the question (a recommendation stays with it), after it — the answer; a bold label in the answer doesn't cut it.
 * The mark at the start or end — the question and the answer are split by the text (`splitAnswer`).
 */
export function autoAnswers(body: string): AutoAnswer[] {
  return questionItems(body).flatMap((item) => {
    const text = item.lines.map((l) => l.trim()).join("\n").replace(/^\d+\.\s*/, "");
    const m = AUTO_RE.exec(text);
    if (!m) return [];
    const before = text.slice(0, m.index).replace(dashes.end, "");
    const after = text.slice(m.index + m[0].length).replace(dashes.start, "");
    if (before && after) return [{ question: before, answer: after }];
    return before || after ? [splitAnswer(before || after)] : [];
  });
}

// ----------------------------------------------------------------------------
// What a session waits for
// ----------------------------------------------------------------------------

/** Checks state: running, red, green; no checks — null. */
export type Checks = "pending" | "failure" | "success" | null;

/** The task's PR: open or merged, its checks and conflict; `deploy` — the merge commit's checks. */
export interface PrInfo {
  number: number;
  url: string;
  branch: string;
  /** Tasks the PR closes (`Closes #N`). */
  closes: number[];
  merged: boolean;
  checks: Checks;
  conflict: boolean;
  deploy: Checks;
  /** The commits have the cloud session trailer `Claude-Session`. */
  cloud: boolean;
}

export type WaitKey = "human" | "merge" | "silent" | "ci-red" | "ci" | "deploy" | "working" | "done" | "none" | "cloud";

export interface Wait {
  key: WaitKey;
  label: string;
  detail: string;
}

const LABEL: Record<WaitKey, string> = {
  human: "human reply",
  merge: "merge",
  silent: "silence",
  "ci-red": "CI red",
  ci: "CI running",
  deploy: "deploy",
  working: "working",
  done: "can be closed",
  none: "no session",
  cloud: "cloud, state not visible",
};

/**
 * What a task's session waits for. A running background task wakes the session itself — it outranks the answer: what
 * it waits for shows from the PR (open and checks running — CI, merged and the merge commit's checks running —
 * deploy). A model answer without a tool call — the human's turn; if the PR is green and mergeable meanwhile, it
 * waits for the merge. Neither, and no records for longer than the threshold — silence.
 */
export function waitOf(s: Transcript | null, pr: PrInfo | null, now: number): Wait {
  const w = (key: WaitKey, detail = ""): Wait => ({ key, label: LABEL[key], detail });
  // a cloud session doesn't pin its task: GitHub projects are unreachable for it, its state isn't visible from here
  if (!s) return pr?.cloud ? w("cloud") : w("none");
  if (s.archived) return w("done", "session archived");
  const bg = s.bg.filter((b) => now - b.at <= BG_MAX);
  if (bg.length) {
    const what = `in background: ${bg.map((b) => b.what).join("; ")}`;
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
  if (s.last === null || now - s.last > SILENCE) return w("silent", s.pendingTool ? `call ${s.pendingTool} without a result — waiting for permission or stuck` : "no records, nothing in background");
  return w("working");
}

// ----------------------------------------------------------------------------
// Tab
// ----------------------------------------------------------------------------

/** An "In progress" task and its epic. */
export interface Task {
  number: number;
  title: string;
  parent: { number: number; title: string } | null;
}

/**
 * What GitHub knows about a repository: "In progress" tasks (without epics), PRs, tasks with open questions, tasks
 * changed within the last day — `edited` is when their description was edited (never — created), epoch seconds.
 */
export interface Live {
  tasks: Task[];
  prs: PrInfo[];
  questions: { number: number; title: string; body: string }[];
  recent: { number: number; title: string; body: string; edited: number }[];
}

export interface SessionsInput {
  /** Pins: `owner/repo#N` → session ids. */
  pins: Record<string, string[]>;
  /** Transcripts of pinned sessions by id. */
  transcripts: Record<string, Transcript>;
  /** GitHub by repository. */
  live: Record<string, Live>;
  /** Recent sessions of the repository's directories — their questions, if they have no "In progress" task. */
  others: Record<string, Transcript[]>;
  /** Hosts of the task-env proxy's routes; the proxy isn't running — none. */
  hosts: string[];
  /** The proxy's port: the address URL carries it unless it is 80. */
  port: string;
}

/** A link to a service of the task's stack. */
export interface Address {
  service: string;
  url: string;
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
  /** Addresses of the task stack's services; no stack — none. */
  addresses: Address[];
}

/**
 * A question to the owner: from a task (its session's answer), from a session without an "In progress" task or from
 * a task with the "questions" label.
 */
export interface Ask {
  /** `issue` — an "In progress" task with the "questions" label, `backlog` — the other tasks with the label. */
  kind: "task" | "session" | "issue" | "backlog";
  repo: string;
  head: string;
  url: string | null;
  session: Transcript | null;
  lines: string[];
}

/** A task whose description got answers marked `autoAnswer` within the last day. */
export interface Decided {
  repo: string;
  number: number;
  title: string;
  url: string;
  edited: number;
  answers: AutoAnswer[];
}

export interface SessionsView {
  rows: SessionRow[];
  asks: Ask[];
  autos: Decided[];
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const OWNER = new Set<WaitKey>(["human", "merge"]);
// on top — those waiting for the owner, then silent and red ones: they're looked at first
const RANK: Partial<Record<WaitKey, number>> = { human: 0, merge: 0, silent: 1, "ci-red": 1 };

/** The task's PR: an open one, otherwise the last merged; the link is `Closes #N` or the branch `<type>/<N>-…`. */
function prFor(live: Live, n: number): PrInfo | null {
  const mine = live.prs.filter((p) => p.closes.includes(n) || branchIssueNumber(p.branch) === n);
  return mine.find((p) => !p.merged) ?? mine[0] ?? null;
}

/**
 * Addresses of a task's services — the proxy's hosts `<service>.<N>.<project>.localhost` with its number and its
 * repository as the project (task-env). e2e addresses aren't shown: that stack is recreated on every run, a link to it
 * lives minutes (#396, question 4).
 */
function addressesOf(inp: SessionsInput, repo: string, n: number): Address[] {
  const project = hostProject(repo.slice(repo.indexOf("/") + 1));
  return inp.hosts
    .flatMap((host) => {
      const a = taskAddress(host);
      return a && !a.e2e && a.task === n && a.project === project ? [{ service: a.service, url: addressUrl(host, inp.port) }] : [];
    })
    .sort((a, b) => a.service.localeCompare(b.service));
}

/** "In progress" task lines and questions to the owner. */
export function sessionsView(inp: SessionsInput, now: number): SessionsView {
  const pinned = new Set<string>();
  const rows: SessionRow[] = Object.entries(inp.live).flatMap(([repo, live]) =>
    live.tasks.map((t) => {
      const ids = inp.pins[`${repo}#${t.number}`] ?? [];
      ids.forEach((id) => pinned.add(id));
      // after /clear the task has a new session and the old pin stays: the one that wrote last is taken
      const session = ids.map((id) => inp.transcripts[id]).filter((s): s is Transcript => !!s).sort((a, b) => (b.last ?? 0) - (a.last ?? 0))[0] ?? null;
      const pr = prFor(live, t.number);
      return {
        repo, number: t.number, title: t.title, url: issueUrl(repo, t.number), session, pr, wait: waitOf(session, pr, now),
        epic: t.parent ? { ...t.parent, url: issueUrl(repo, t.parent.number) } : null, addresses: addressesOf(inp, repo, t.number),
      };
    }),
  );
  rows.sort((a, b) => (RANK[a.wait.key] ?? 2) - (RANK[b.wait.key] ?? 2) || a.repo.localeCompare(b.repo) || a.number - b.number);

  const asks: Ask[] = rows.filter((r) => OWNER.has(r.wait.key)).map((r) => ({ kind: "task", repo: r.repo, head: `#${r.number} ${r.title}`, url: r.url, session: r.session, lines: questionOf(r.session!.answer ?? "")!.split("\n") }));
  for (const [repo, list] of Object.entries(inp.others)) {
    // a routine and an answer without an explicit question aren't for the owner: otherwise the block drowns in
    // scheduled reports
    const recent = list.flatMap((s) => {
      const q = !pinned.has(s.id) && !s.routine && s.last !== null && now - s.last <= RECENT && waitOf(s, null, now).key === "human" ? questionOf(s.answer!, true) : null;
      return q === null ? [] : [{ s, q }];
    });
    for (const { s, q } of recent.sort((a, b) => b.s.last! - a.s.last!)) asks.push({ kind: "session", repo, head: s.title ?? `session ${s.id.slice(0, 8)}`, url: null, session: s, lines: q.split("\n") });
  }
  const issues = Object.entries(inp.live).flatMap(([repo, live]) =>
    live.questions.map((q): Ask => {
      const inWork = live.tasks.some((t) => t.number === q.number);
      return { kind: inWork ? "issue" : "backlog", repo, head: `#${q.number} ${q.title}`, url: issueUrl(repo, q.number), session: null, lines: openQuestions(q.body) };
    }),
  );
  asks.push(...issues.filter((a) => a.kind === "issue"), ...issues.filter((a) => a.kind === "backlog"));
  // the window is by the description's edit, not by the task's update: a comment or a close would bring back old answers
  const autos = Object.entries(inp.live).flatMap(([repo, live]) =>
    live.recent.flatMap((i): Decided[] => {
      const answers = now - i.edited <= AUTO_WINDOW ? autoAnswers(i.body) : [];
      return answers.length ? [{ repo, number: i.number, title: i.title, url: issueUrl(repo, i.number), edited: i.edited, answers }] : [];
    }),
  );
  autos.sort((a, b) => b.edited - a.edited || a.repo.localeCompare(b.repo) || a.number - b.number);
  return { rows, asks, autos };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const link = (url: string, text: string) => `<a href="${esc(url)}">${esc(text)}</a>`;

/** Time elapsed: "4 min ago", "2 h 5 min ago", "3 d ago". */
function ago(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ""} ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const when = (s: Transcript, now: number) => (s.last === null ? "no records" : ago(now - s.last));
/** The session name, if it doesn't repeat the task: by the canon a session is named "#N <task name>". */
const ownTitle = (s: Transcript, task: string) => (s.title === null ? `untitled, ${s.id.slice(0, 8)}` : s.title === task ? null : s.title);
const CHECKS: Record<string, string> = { pending: "checks running", failure: "checks red", success: "checks green", null: "no checks" };
const DEPLOY: Record<string, string> = { pending: " · deploy running", failure: " · deploy red", success: "", null: "" };

function prCell(p: PrInfo | null): string {
  if (!p) return "—";
  const state = p.merged ? `merged${DEPLOY[String(p.deploy)]}` : `${CHECKS[String(p.checks)]}${p.conflict ? " · conflict" : ""}`;
  return `${link(p.url, `#${p.number}`)} ${esc(state)}`;
}

function asksBlock(asks: Ask[], now: number, many: boolean): string {
  const item = (a: Ask) => {
    const head = `${many ? a.repo : ""}${a.head}`;
    const top = (sub: string) => `<div class="ask-head">${a.url ? link(a.url, head) : esc(head)} <span class="minor">${esc(sub)}</span></div>`;
    const text = (lines: string[]) => `<div class="ask-text">${lines.map(esc).join("<br>")}</div>`;
    // tasks with questions number in the dozens: as a line, the questions themselves — under a disclosure
    if (a.kind === "issue" || a.kind === "backlog")
      return `<li>${top(a.lines.length ? `questions label · open: ${a.lines.length}` : "questions label")}${a.lines.length ? `<details data-key="${esc(`${a.repo}${a.head}`)}"><summary>questions</summary>${text(a.lines)}</details>` : ""}</li>`;
    const name = a.kind === "task" ? ownTitle(a.session!, a.head) : null;
    return `<li>${top(a.kind === "task" ? `session${name ? ` «${name}»` : ""} · ${when(a.session!, now)}` : `session without a task in progress · ${when(a.session!, now)}`)}${text(a.lines)}</li>`;
  };
  const live = asks.filter((a) => a.kind !== "backlog");
  const backlog = asks.filter((a) => a.kind === "backlog");
  // backlog questions wait until the task is taken: collapsed so as not to obscure the sessions that are stuck now
  const rest = backlog.length ? `<details class="backlog" data-key="backlog"><summary>tasks with questions, not in progress: ${backlog.length}</summary><ul>${backlog.map(item).join("")}</ul></details>` : "";
  return `<section class="asks card"><h2>Waiting for the owner</h2>${live.length ? `<ul>${live.map(item).join("")}</ul>` : `<p class="note">no questions</p>`}${rest}</section>`;
}

function rowsTable(rows: SessionRow[], now: number, many: boolean): string {
  if (!rows.length) return `<p class="card">No tasks in progress.</p>`;
  const body = rows.map((r) => {
    const addresses = r.addresses.length ? `<div class="minor addresses">services: ${r.addresses.map((a) => `<a href="${esc(a.url)}" title="${esc(a.url)}">${esc(a.service)}</a>`).join(" · ")}</div>` : "";
    const task = `${link(r.url, `${many ? r.repo : ""}#${r.number}`)} ${esc(r.title)}${r.epic ? `<div class="minor">epic ${link(r.epic.url, `#${r.epic.number} ${r.epic.title}`)}</div>` : ""}${addresses}`;
    const name = r.session && ownTitle(r.session, `#${r.number} ${r.title}`);
    const session = r.session ? `${esc(when(r.session, now))}${name ? `<div class="minor">${esc(name)}</div>` : ""}` : "—";
    const wait = `<span class="wait ${r.wait.key}">${esc(r.wait.label)}</span>${r.wait.detail ? `<div class="minor">${esc(r.wait.detail)}</div>` : ""}`;
    return `<tr data-task="${esc(`${r.repo}#${r.number}`)}"><td>${task}</td><td>${session}</td><td>${wait}</td><td>${prCell(r.pr)}</td></tr>`;
  });
  return `<section class="card scroll"><table class="sessions"><thead><tr><th>Task</th><th>Session</th><th>Waiting for</th><th>PR</th></tr></thead><tbody>${body.join("")}</tbody></table></section>`;
}

/** "Decided auto": a line per answer — the task (once for its answers), the question, the answer; none — no block. */
function autosBlock(autos: Decided[], now: number, many: boolean): string {
  if (!autos.length) return "";
  const lines = (s: string) => s.split("\n").map(esc).join("<br>");
  const body = autos.flatMap((d) =>
    d.answers.map((a, i) => {
      const task = i ? "" : `<td rowspan="${d.answers.length}">${link(d.url, `${many ? d.repo : ""}#${d.number} ${d.title}`)}<div class="minor">edited ${esc(ago(now - d.edited))}</div></td>`;
      return `<tr>${task}<td>${lines(a.question)}</td><td>${lines(a.answer)}</td></tr>`;
    }),
  );
  return `<section class="autos card scroll"><h2>Decided auto</h2><p class="note">answers marked ✅ auto in tasks whose description changed within a day</p><table class="autos"><thead><tr><th>Task</th><th>Question</th><th>Answer</th></tr></thead><tbody>${body.join("")}</tbody></table></section>`;
}

/**
 * The tab's content: "Waiting for the owner" on top, below it — a line per "In progress" task, at the bottom — what
 * sessions decided themselves: it's looked at after the fact.
 */
export function sessionsBody(v: SessionsView, now: number, many: boolean): string {
  return asksBlock(v.asks, now, many) + rowsTable(v.rows, now, many) + autosBlock(v.autos, now, many);
}

/**
 * The tab's self-refresh: every `sec` seconds and on returning to the tab — the page afresh and `<main>` replaced,
 * what's expanded stays expanded; a hidden tab doesn't refresh. A reload (meta refresh) would collapse expanded
 * questions every half minute.
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

/** The tab's styles; colors are the page's theme variables. */
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
.autos .note{margin:0 0 8px}
table.autos th,table.autos td{text-align:left;white-space:normal;vertical-align:top}
table.autos td:first-child{min-width:200px}
table.autos td:not(:first-child){min-width:220px}
.wait{display:inline-block;padding:1px 8px;border-radius:999px;font-size:13px;border:1px solid var(--border);white-space:nowrap}
.wait.human,.wait.merge{background:var(--warn);color:#000;border-color:transparent}
.wait.silent,.wait.ci-red{background:var(--bad);color:#fff;border-color:transparent}
.wait.ci,.wait.deploy,.wait.working{color:var(--fact)}
.wait.done{color:var(--good)}
.wait.none,.wait.cloud{color:var(--muted)}
`;

// ----------------------------------------------------------------------------
// Reading: pins, transcripts, GitHub
// ----------------------------------------------------------------------------

/**
 * Pins of tasks to sessions: `owner/repo#N` → session ids (the `sessions/<id>` files of the configuration directory).
 */
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

/** A file's transcript; re-parsed only if the file changed. Subagent records are a sign of the session's life too. */
function readTranscript(file: string): Transcript {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  let t = parsed.get(file)?.key === key ? parsed.get(file)!.t : null;
  if (!t) {
    t = parseTranscript(path.basename(file, ".jsonl"), readFileSync(file, "utf8"));
    parsed.set(file, { key, t });
  }
  // a subagent writes to its own transcript (<id>/subagents/), and the session waits for it without records
  const sub = path.join(file.slice(0, -".jsonl".length), "subagents");
  let subAt = 0;
  try {
    for (const f of readdirSync(sub)) subAt = Math.max(subAt, statSync(path.join(sub, f)).mtimeMs / 1000);
  } catch {
    // no subagents
  }
  return subAt > (t.last ?? 0) ? { ...t, last: subAt } : t;
}

/** Transcript files `<directory>/<name>.jsonl` of the `projectsDir` directories that match `match`. */
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

/** Session transcripts by id — in any project's directory: a session also works from someone else's directory. */
export function findTranscripts(ids: string[], projectsDir = PROJECTS_DIR): Record<string, Transcript> {
  const want = new Set(ids.map((id) => `${id}.jsonl`));
  const out: Record<string, Transcript> = {};
  if (!want.size) return out;
  for (const f of transcriptFiles((_, n) => want.has(n), projectsDir)) {
    const t = readTranscript(f);
    // one id in two directories (the app moved the transcript) — the fresh one
    if ((t.last ?? 0) >= (out[t.id]?.last ?? 0)) out[t.id] = t;
  }
  return out;
}

/**
 * Transcripts of the repository's directories (`paths` of the est registry and their worktrees) modified no earlier
 * than `since`.
 */
export function repoTranscripts(paths: string[], since: number, projectsDir = PROJECTS_DIR): Transcript[] {
  const encs = paths.map(encodePath);
  if (!encs.length) return [];
  const files = transcriptFiles((d) => encs.some((e) => d.startsWith(e)), projectsDir);
  return files.filter((f) => statSync(f).mtimeMs / 1000 >= since).map(readTranscript);
}

const ROLLUP: Record<string, Checks> = { SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending" };
const rollup = (state: unknown): Checks => ROLLUP[String(state)] ?? null;
const EPIC_TYPES = locale.every((n) => n.issueTypes.epic).map((t) => t.toLowerCase());
const isEpic = (i: Any) => (i.labels?.nodes ?? []).some((l: Any) => l.name === "epic") || EPIC_TYPES.includes(String(i.issueType?.name ?? "").toLowerCase());
const PR_FIELDS = "number url headRefName mergeable closingIssuesReferences(first:10){nodes{number}} commits(last:20){nodes{commit{messageBody statusCheckRollup{state}}}}";

/**
 * "In progress" tasks, PRs and tasks with the "questions" label from the GitHub response; an epic isn't a line: its
 * session plans rather than does.
 */
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
    recent: (repo?.recent?.nodes ?? [])
      .map((i: Any) => ({ number: i.number, title: i.title, body: i.body ?? "", edited: Date.parse(i.lastEditedAt ?? i.createdAt ?? "") / 1000 }))
      .filter((i: { edited: number }) => Number.isFinite(i.edited)),
  };
}

/** `gh api graphql` without blocking the server: the tab answers from the cache while GitHub gathers fresh data. */
function graphql(query: string, variables: Record<string, unknown>): Promise<Any> {
  return new Promise((resolve, reject) => {
    const p = spawn("gh", ["api", "graphql", "--input", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new EstError((e as NodeJS.ErrnoException).code === "ENOENT" ? "command 'gh' not found; the gh CLI must be installed" : `gh api graphql: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) return reject(new EstError(`command gh api graphql… exited with code ${code}: ${err.trim().slice(0, 500)}`));
      let data: Any;
      try {
        data = JSON.parse(out);
      } catch {
        return reject(new EstError(`gh api graphql: the response isn't JSON: ${out.slice(0, 200)}`));
      }
      // a partial response (no access to one task) — there is data, take it
      if (data.errors?.length && !data.data) return reject(new EstError(`GraphQL: ${data.errors.map((e: Any) => e.message ?? "").join("; ")}`));
      resolve(data.data);
    });
    p.stdin.end(JSON.stringify({ query, variables }));
  });
}

/**
 * One request per repository: "In progress" tasks with their epic — by a project filter on GitHub's side (whole
 * project rows, with comments, as for the "Estimate and actual" tab, take tens of seconds), open and recently merged
 * PRs, tasks with the "questions" label, tasks updated within the last day — GitHub filters by any update, the window
 * by the description's edit is applied by `sessionsView`.
 */
export async function liveQuery(full: string, projectId: string): Promise<Live> {
  // a cloud session has Projects v2 closed to it; dashboard exits earlier, this is for a call that bypasses it
  if (process.env.CLAUDE_CODE_REMOTE === "true") throw new EstError("Claude Code cloud session: GitHub projects aren't reachable from here (docs/cloud-sessions.md in ai-dev)");
  const [o, r] = full.split("/");
  const q = `query($o:String!,$r:String!,$p:ID!,$q:String!,$since:DateTime!){
    project: node(id:$p){ ... on ProjectV2{ items(first:100, query:$q){ nodes{ content{ __typename
      ... on Issue{ number title state issueType{name} labels(first:15){nodes{name}} parent{ number title } } } } } } }
    repository(owner:$o,name:$r){
      open: pullRequests(states:OPEN, first:50, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PR_FIELDS} } }
      merged: pullRequests(states:MERGED, first:30, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PR_FIELDS} mergeCommit{ statusCheckRollup{state} } } }
      questions: issues(states:OPEN, labels:${JSON.stringify(locale.every((n) => n.labels.questions))}, first:50){ nodes{ number title body } }
      recent: issues(filterBy:{since:$since}, first:100, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ number title body createdAt lastEditedAt } } } }`;
  const since = new Date(Date.now() - AUTO_WINDOW * 1000).toISOString();
  // the project filter: comma-separated values — any of them
  return packLive(await graphql(q, { o, r, p: projectId, q: `status:${IN_WORK.map((s) => JSON.stringify(s)).join(",")}`, since }));
}
