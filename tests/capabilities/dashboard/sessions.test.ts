import { describe, expect, it } from "bun:test";

import { BG_MAX, openQuestions, parseTranscript, questionOf, RECENT, SILENCE, sessionsBody, sessionsView } from "../../../skills/dashboard/scripts/sessions.ts";
import type { Live, PrInfo, SessionsInput, Task, Transcript } from "../../../skills/dashboard/scripts/sessions.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z") / 1000;
const MIN = 60;
const iso = (t: number) => new Date(t * 1000).toISOString();

// Записи транскрипта Claude Code (~/.claude/projects/<каталог>/<id сессии>.jsonl) в том виде, в каком их пишет приложение.
const title = (s: string) => ({ type: "custom-title", customTitle: s });
const prompt = (t: number, text: string) => ({ type: "user", timestamp: iso(t), message: { role: "user", content: text } });
const say = (t: number, text: string, id = `msg-${t}`) => ({ type: "assistant", timestamp: iso(t), message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
const call = (t: number, name: string, input: Record<string, unknown> = {}, id = `tu-${t}`) => ({
  type: "assistant", timestamp: iso(t), message: { id: `msg-${t}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const result = (t: number, toolId: string, extra: Record<string, unknown> = {}) => ({
  type: "user", timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }, toolUseResult: extra,
});
const notify = (t: number, taskId: string) => ({ type: "user", timestamp: iso(t), message: { role: "user", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } });
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** Фоновая команда: вызов Bash с run_in_background и ответ с её id. */
const bgCommand = (t: number, taskId: string, description: string) => [call(t, "Bash", { command: "wait-ci.sh", description, run_in_background: true }, `tu-${taskId}`), result(t + 1, `tu-${taskId}`, { backgroundTaskId: taskId })];

/** Транскрипт сессии `id` с названием `name` и записями `recs`. */
const session = (id: string, name: string, ...recs: unknown[]): Transcript => parseTranscript(id, jsonl(title(name), ...recs));

const pr = (o: Partial<PrInfo> = {}): PrInfo => ({ number: 70, url: "https://github.com/o/r/pull/70", branch: "feat/7-export", closes: [7], merged: false, checks: "success", conflict: false, deploy: null, cloud: false, ...o });
const live = (o: Partial<Live> = {}): Live => ({ tasks: [], prs: [], questions: [], ...o });
const task = (number: number, title = `Задача ${number}`, parent: Task["parent"] = null): Task => ({ number, title, parent });
const input = (o: Partial<SessionsInput> = {}): SessionsInput => ({ pins: {}, transcripts: {}, live: {}, others: {}, ...o });
const byId = (...ts: Transcript[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** Строка таблицы задачи по номеру: текст её ячеек. */
const rowText = (html: string, task: string) => text(new RegExp(`<tr[^>]*data-task="${task}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? "");

describe("Транскрипт сессии — название, последняя запись, фоновые задачи и последний ход", () => {
  it("название — последнее переименование, время — последней записи с меткой времени", () => {
    const t = parseTranscript("s1", jsonl(title("#7 Экспорт"), prompt(NOW - 20 * MIN, "#7"), title("#7 Экспорт счетов"), say(NOW - 9 * MIN, "Готово?"), { type: "last-prompt" }));
    expect(t).toMatchObject({ id: "s1", title: "#7 Экспорт счетов", last: NOW - 9 * MIN });
  });

  it("фоновая задача — запуск без уведомления о завершении: команда, субагент, монитор", () => {
    const t = parseTranscript("s1", jsonl(
      ...bgCommand(NOW - 30 * MIN, "b1", "Тесты в фоне"),
      ...bgCommand(NOW - 20 * MIN, "b2", "Ждать чеки PR 70"),
      call(NOW - 19 * MIN, "Agent", { description: "Актуализация блока" }, "tu-a1"),
      result(NOW - 19 * MIN, "tu-a1", { isAsync: true, status: "async_launched", agentId: "a1", description: "Актуализация блока" }),
      call(NOW - 18 * MIN, "Monitor", { description: "Деплой" }, "tu-m1"),
      result(NOW - 18 * MIN, "tu-m1", { taskId: "m1", timeoutMs: 1_800_000 }),
      notify(NOW - 10 * MIN, "b1"),
      // остановленная TaskStop уведомления не шлёт — завершение видно по её результату
      ...bgCommand(NOW - 17 * MIN, "b3", "Сервер дашборда"),
      call(NOW - 16 * MIN, "TaskStop", { task_id: "b3" }, "tu-stop"),
      result(NOW - 16 * MIN, "tu-stop", { message: "Successfully stopped task: b3 (bun dashboard.ts)", task_id: "b3", task_type: "local_bash" }),
    ));
    expect(t.bg).toEqual([{ id: "b2", at: NOW - 20 * MIN + 1, what: "Ждать чеки PR 70" }, { id: "a1", at: NOW - 19 * MIN, what: "Актуализация блока" }, { id: "m1", at: NOW - 18 * MIN, what: "Деплой" }]);
  });

  it("последний ход — ответ модели без вызова инструмента: его текст; вызов инструмента без результата — имя инструмента", () => {
    const answered = parseTranscript("s1", jsonl(prompt(NOW - 9 * MIN, "#7"), call(NOW - 8 * MIN, "Bash"), result(NOW - 8 * MIN, "tu-" + (NOW - 8 * MIN)), say(NOW - 7 * MIN, "PR зелёный.", "m9"), say(NOW - 7 * MIN, "Осталось: мерж — от владельца.", "m9")));
    expect(answered).toMatchObject({ answer: "PR зелёный.\n\nОсталось: мерж — от владельца.", pendingTool: null });
    const running = parseTranscript("s1", jsonl(prompt(NOW - 9 * MIN, "#7"), say(NOW - 8 * MIN, "Смотрю."), call(NOW - 8 * MIN, "Bash")));
    expect(running).toMatchObject({ answer: null, pendingTool: "Bash" });
    // результат пришёл — модель думает над следующим шагом
    const thinking = parseTranscript("s1", jsonl(call(NOW - 8 * MIN, "Bash"), result(NOW - 8 * MIN, "tu-" + (NOW - 8 * MIN))));
    expect(thinking).toMatchObject({ answer: null, pendingTool: null });
  });

  it("сессия, архивировавшая себя последним ходом, — архивирована; новый промпт после архивации — снова в работе", () => {
    const archive = call(NOW - 5 * MIN, "mcp__ccd_session_mgmt__archive_session", { session_id: "self" }, "tu-arch");
    expect(parseTranscript("s1", jsonl(say(NOW - 6 * MIN, "Всё сделано. Сессию можно закрывать."), archive, result(NOW - 5 * MIN, "tu-arch"), say(NOW - 5 * MIN, "Сессия архивирована."))).archived).toBe(true);
    expect(parseTranscript("s1", jsonl(archive, result(NOW - 5 * MIN, "tu-arch"), prompt(NOW - 2 * MIN, "ещё вопрос"))).archived).toBe(false);
  });
});

describe("Строка задачи «В работе» — её сессия и чего она ждёт", () => {
  it("задача «В работе» с закреплённой сессией показывает возраст последней записи и чего сессия ждёт: CI, мерж, деплой или ответа человека", () => {
    const tasks = [1, 2, 3, 4].map((n) => task(n));
    const transcripts = byId(
      // ждёт CI: фоновое ожидание чеков, PR открыт, чеки идут
      session("s1", "#1 Задача 1", ...bgCommand(NOW - 5 * MIN, "b1", "Ждать чеки PR 71")),
      // ждёт мержа: ответила человеку, PR зелёный и вливается
      session("s2", "#2 Задача 2", say(NOW - 3 * MIN, "CI зелёный.\n\nОсталось: мерж — от владельца.")),
      // ждёт деплоя: PR влит, фоновое ожидание чеков коммита мержа
      session("s3", "#3 Задача 3", ...bgCommand(NOW - 25 * MIN, "b3", "Ждать деплой")),
      // ждёт ответа человека: вопрос, PR ещё нет
      session("s4", "#4 Порог тишины", say(NOW - 125 * MIN, "Какой порог выбрать — 15 или 30 мин?")),
    );
    const prs = [pr({ number: 71, closes: [1], checks: "pending" }), pr({ number: 72, closes: [2] }), pr({ number: 73, branch: "feat/3-x", closes: [], merged: true, deploy: "pending" })];
    const v = sessionsView(input({ pins: { "o/r#1": ["s1"], "o/r#2": ["s2"], "o/r#3": ["s3"], "o/r#4": ["s4"] }, transcripts, live: { "o/r": live({ tasks, prs }) } }), NOW);
    expect(Object.fromEntries(v.rows.map((r) => [r.number, r.wait.key]))).toEqual({ 1: "ci", 2: "merge", 3: "deploy", 4: "human" });
    expect(v.rows.find((r) => r.number === 3)?.pr?.number).toBe(73);
    const html = sessionsBody(v, NOW, false);
    expect(rowText(html, "o/r#1")).toContain("CI идёт");
    // сессия названа по задаче — название не повторяется, видно только время последней записи
    expect(rowText(html, "o/r#1")).toContain("4 мин назад");
    expect(rowText(html, "o/r#1").match(/Задача 1/g)).toHaveLength(1);
    expect(rowText(html, "o/r#2")).toContain("мерж");
    expect(rowText(html, "o/r#3")).toContain("деплой");
    expect(rowText(html, "o/r#4")).toContain("ответ человека");
    expect(rowText(html, "o/r#4")).toContain("2 ч 5 мин назад #4 Порог тишины");
    // PR: номер, чеки, конфликт
    expect(rowText(html, "o/r#1")).toContain("#71 чеки идут");
    expect(rowText(html, "o/r#3")).toContain("#73 влит");
  });

  it("красные чеки при фоновом ожидании — «CI красный», конфликт PR — в его ячейке", () => {
    const v = sessionsView(input({
      pins: { "o/r#7": ["s1"] }, transcripts: byId(session("s1", "#7 Экспорт", ...bgCommand(NOW - 5 * MIN, "b1", "Ждать чеки"))),
      live: { "o/r": live({ tasks: [task(7, "Экспорт")], prs: [pr({ checks: "failure", conflict: true })] }) },
    }), NOW);
    expect(v.rows[0]!.wait.key).toBe("ci-red");
    expect(rowText(sessionsBody(v, NOW, false), "o/r#7")).toContain("#70 чеки красные · конфликт");
  });

  it("сессия без записей дольше порога, у которой ничего не идёт в фоне, помечена «тишина»", () => {
    const one = (...recs: unknown[]) => input({ pins: { "o/r#7": ["s1"] }, transcripts: byId(session("s1", "#7", ...recs)), live: { "o/r": live({ tasks: [task(7, "Экспорт")] }) } });
    const wait = (...recs: unknown[]) => sessionsView(one(...recs), NOW).rows[0]!.wait;
    expect(wait(call(NOW - SILENCE + MIN, "Bash")).key).toBe("working");
    const hung = wait(call(NOW - SILENCE - MIN, "Bash"));
    expect(hung.key).toBe("silent");
    // вызов без результата: ждёт разрешения или завис — видно, какой
    expect(hung.detail).toContain("Bash");
    // в фоне идёт команда — не тишина, а работа
    expect(wait(...bgCommand(NOW - SILENCE - 10 * MIN, "b1", "Тесты в фоне")).key).toBe("working");
    // фоновая без уведомления дольше потолка — потеряна (сессию закрыли)
    expect(wait(...bgCommand(NOW - BG_MAX - MIN, "b1", "Тесты в фоне")).key).toBe("silent");
    const html = sessionsBody(sessionsView(one(call(NOW - 40 * MIN, "Bash")), NOW), NOW, false);
    expect(rowText(html, "o/r#7")).toContain("тишина");
    expect(html).toMatch(/<span class="wait silent"/);
  });

  it("задача «В работе» без закреплённой сессии — строкой «сессии нет»; облачная (трейлер Claude-Session в PR) — «облако, состояние не видно»", () => {
    const v = sessionsView(input({
      live: { "o/r": live({ tasks: [task(7, "Экспорт", { number: 5, title: "Биллинг" }), task(8, "Импорт")], prs: [pr({ number: 80, branch: "feat/8-import", closes: [8], cloud: true })] }) },
    }), NOW);
    expect(v.rows.map((r) => [r.number, r.wait.key, r.session])).toEqual([[7, "none", null], [8, "cloud", null]]);
    const html = sessionsBody(v, NOW, false);
    expect(rowText(html, "o/r#7")).toContain("сессии нет");
    // эпик задачи — под её названием
    expect(rowText(html, "o/r#7")).toContain("эпик #5 Биллинг");
    expect(rowText(html, "o/r#8")).toContain("облако, состояние не видно");
  });

  it("из нескольких сессий задачи — та, что писала последней; ответ «Всё сделано. Сессию можно закрывать.» — не вопрос", () => {
    const v = sessionsView(input({
      live: { "o/r": live({ tasks: [task(7, "Экспорт")] }) }, pins: { "o/r#7": ["old", "new"] },
      transcripts: byId(session("old", "#7 до /clear", say(NOW - 90 * MIN, "Какой вариант?")), session("new", "#7 Экспорт", say(NOW - 2 * MIN, "Влито.\n\nВсё сделано. Сессию можно закрывать."))),
    }), NOW);
    expect(v.rows[0]!.session?.id).toBe("new");
    expect(v.rows[0]!.wait.key).toBe("done");
    expect(v.asks).toEqual([]);
  });
});

describe("Ждут владельца — вопросы сессий и задач", () => {
  it("вопрос сессии — строки «Всё сделано, но есть вопросы» / «Осталось: …» до конца ответа, без них — последний абзац", () => {
    expect(questionOf("Влил PR.\n\nВсё сделано, но есть вопросы:\n1. Порог 15 мин?\n2. Облако?")).toBe("Всё сделано, но есть вопросы:\n1. Порог 15 мин?\n2. Облако?");
    expect(questionOf("PR зелёный.\n**Осталось:** мерж — от владельца.")).toBe("**Осталось:** мерж — от владельца.");
    expect(questionOf("Нашёл два варианта.\n\nКакой берём — A или B?")).toBe("Какой берём — A или B?");
    expect(questionOf("Влито.\n\nВсё сделано. Сессию можно закрывать.")).toBeNull();
    // строго (сессия без задачи) — только явный вопрос: строки конца сессии или последний абзац на «?»
    expect(questionOf("Отдельная задача не нужна.", true)).toBeNull();
    expect(questionOf("Нашёл два варианта.\n\nКакой берём — **A или B?**", true)).toBe("Какой берём — **A или B?**");
    expect(questionOf("Сделал.\n\nОсталось: мерж — от владельца.", true)).toBe("Осталось: мерж — от владельца.");
  });

  it("рутина — сессия, начатая промптом <scheduled-task>", () => {
    const routine = parseTranscript("r1", jsonl(prompt(NOW - 9 * MIN, '<scheduled-task name="report">\nОтчёт за час'), say(NOW - 8 * MIN, "За час заявок не было?")));
    expect(routine.routine).toBe(true);
    expect(parseTranscript("s1", jsonl(prompt(NOW - 9 * MIN, "#7"), prompt(NOW - 8 * MIN, '<scheduled-task name="check">'))).routine).toBe(false);
  });

  it("открытые вопросы задачи — пункты «## Вопросы» без ✅", () => {
    const body = "## Что сделать\n1. не вопрос\n\n## Вопросы\n1. Порог?\n   ✅ 15 мин.\n2. Облако? Рекомендация: вне охвата.\n3. Эпик?\n\n## Сценарии\n- x\n";
    expect(openQuestions(body)).toEqual(["2. Облако? Рекомендация: вне охвата.", "3. Эпик?"]);
  });

  it("блок «Ждут владельца» собирает вопросы из последних ответов сессий и задачи с меткой «вопросы»", () => {
    const v = sessionsView(input({
      pins: { "o/r#7": ["s7"], "o/r#8": ["s8"] },
      transcripts: byId(session("s7", "#7 Экспорт", say(NOW - 4 * MIN, "CI зелёный.\n\nОсталось: мерж — от владельца.")), session("s8", "#8 Импорт", call(NOW - MIN, "Bash"))),
      others: {
        "o/r": [
          // эпик без закреплённой задачи: ответ за сутки — вопрос владельцу
          session("e1", "Биллинг · планирование", say(NOW - 3 * 3600, "Разбил эпик.\n\nВсё сделано, но есть вопросы:\n1. Делить <b>импорт</b>?")),
          // старше суток — не в блоке
          session("e2", "Старый разговор", say(NOW - RECENT - 3600, "Что дальше?")),
          // закрыта — не вопрос
          session("e3", "#6 Поиск", say(NOW - 3600, "Всё сделано. Сессию можно закрывать.")),
          // ответ без вопроса и рутина — не вопросы владельцу
          session("e4", "Разговор", say(NOW - 3600, "Отдельная задача не нужна.")),
          parseTranscript("r1", jsonl(title("Отчёт за час"), prompt(NOW - 11 * MIN, '<scheduled-task name="report">'), say(NOW - 10 * MIN, "Почему очередь стоит?"))),
        ],
      },
      live: {
        "o/r": live({
          tasks: [task(7, "Экспорт"), task(8, "Импорт")],
          questions: [{ number: 9, title: "Отчёт по ROI", body: "## Вопросы\n1. Валюта?\n2. Период? ✅ месяц\n" }, { number: 8, title: "Импорт", body: "## Вопросы\n1. Формат?\n" }],
        }),
      },
    }), NOW);
    expect(v.asks.map((a) => [a.head, a.lines])).toEqual([
      ["#7 Экспорт", ["Осталось: мерж — от владельца."]],
      ["Биллинг · планирование", ["Всё сделано, но есть вопросы:", "1. Делить <b>импорт</b>?"]],
      // задача «В работе» с вопросами — выше задач бэклога
      ["#8 Импорт", ["1. Формат?"]],
      ["#9 Отчёт по ROI", ["1. Валюта?"]],
    ]);
    const html = sessionsBody(v, NOW, false);
    const block = /<section class="asks[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(text(block)).toContain("Ждут владельца");
    expect(text(block)).toContain("#7 Экспорт сессия · 4 мин назад");
    // задача с меткой — строкой с числом открытых вопросов, сами вопросы под раскрытием
    expect(text(block)).toContain("#9 Отчёт по ROI метка «вопросы» · открытых: 1");
    expect(block).toMatch(/<details[^>]*><summary>[^<]*<\/summary>[\s\S]*1\. Валюта\?/);
    // задачи бэклога с вопросами — их десятки — свёрнуты группой; задача «В работе» — на виду
    const backlog = /<details class="backlog"[\s\S]*<\/details>/.exec(block)?.[0] ?? "";
    expect(text(backlog)).toContain("задачи с вопросами вне работы: 1");
    expect(backlog).toContain("#9 Отчёт по ROI");
    expect(backlog).not.toContain("#8 Импорт");
    expect(block.indexOf("#8 Импорт")).toBeLessThan(block.indexOf('<details class="backlog"'));
    // текст сессии — данные, а не разметка
    expect(block).toContain("Делить &lt;b&gt;импорт&lt;/b&gt;?");
    // блок — над таблицей задач
    expect(html.indexOf('class="asks')).toBeLessThan(html.indexOf("<table"));
  });

  it("никто не ждёт — блок говорит об этом", () => {
    const html = sessionsBody(sessionsView(input(), NOW), NOW, false);
    expect(text(html)).toContain("Ждут владельца");
    expect(text(html)).toContain("вопросов нет");
    expect(text(html)).toContain("Задач «В работе» нет");
  });
});
