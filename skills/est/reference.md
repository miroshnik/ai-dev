# est — reference

The mechanics behind `SKILL.md`: the repository registry, how the estimate picks
analogs, how the actual finds sessions and counts hours, tokens and cost,
writing and reruns, the cloud session import, the period summary and the
linking details. What to run and when — `SKILL.md`; syntax and flags —
`est --help` and `est <command> --help`.

## Repository registry

The repository registry (which ones exist, where they live locally, the project
number) is a personal file `~/.config/elves/repos.json` (or
`$ELVES_CONFIG_DIR/repos.json`; the old `~/.claude/est` moves by itself; until
`update -g` moves it, the former `~/.config/ai-dev`), not
part of the skill; the format is described at the top of `est.ts`. Without a
registry entry the script determines the repo from `git remote origin`, and the
project from its link to the repository.

## Unit and comment language

Old estimates without the `<!-- est -->` marker (set before `est` was
introduced, in other units) don't go into calibration (k). The «Estimate» and
«Actual» comments are written in the project language of the current checkout
(the `est` keys of the dictionary; the markers are the same in every
language); fields, the questions section, the human's lines and the subagent
assignment («Task #N») are read in any language of the dictionary.

## Estimate — the mechanics

`--type` — like the branch prefix (feat / fix / docs / refactor / perf / test /
chore / ci / build / research); without `--write` everything is only printed.

1. **Analogs** — the three most similar closed tasks with an actual (coverage
   `full`, not epics), **closed before the estimated one was created**.
   Similarity is a sum of features: a shared decision label ×3, the same type ×2,
   a shared title word ×1 (words are compared by their first four letters), minus
   3 × |ln| of the ratio of the issue description sizes (characters, without
   answers to questions — those are added after the estimate); on a tie — the
   more recently closed. The comment names the analogs and how they are similar:
   `Analogs (picked by the script): #24 (actual 0.21 h: label est · type feat · words «estimate», «analogs» · description ×1.3); …`
2. **Forecast** — the median of the analogs' actuals (hours, tokens, cost),
   rounded to the **nearest** step of the scale 0.1 · 0.25 · 0.5 · 1 · 1.5 · 2 ·
   3 · 5 · 8 · 13 h. The script sets the «Estimate, h» field and writes a comment
   (the marker has `"auto": true`):
   `Estimate: 1 h, ≈ 80.7M tokens, ≈ $136 (type fix, confidence A; forecast from the analogs' actuals). Analogs (picked by the script): #4 (actual 0.38 h: …); #5 (actual 0.51 h: …); #9 (actual 1.2 h: …). Correction: ×1. k=0.93 (n=20, level «repo»; for reference, not applied to the forecast).`
   If the analogs' actuals spread by more than ×3, the script adds a range. The
   scale is capped at 13: if the analogs (before rounding) give more, the script
   warns — the task should be split.
3. **Cold start** — fewer than two analogs with an actual closed before the task
   was created: the script prints «No estimate: …», writes nothing, exits with 0
   and doesn't read other repositories; the task stays without an estimate, and
   the tasks created after two have closed get one.
4. k (actual/estimate over history) is for reference: it isn't applied to the
   forecast (the forecast already comes from actuals); `est history` shows it
   with the number of pairs, to see whether estimates match actuals.

Confidence: A — ≥ 3 analogs with an actual and ≥ 5 closed tasks of the same type
with an actual (coverage full) in this repo; B — ≥ 2 analogs with an actual; C — an
expert estimate (`--hours`).

## Manual re-estimate

Only on the owner's request, before work starts:
`est estimate <N> --type <type> … --write` with

- `--analogs 254,260` — analogs by hand (2–3, from `est history [--grep <word>]`);
  from another registry repo — `owner/repo#254`, labeled «from project …» in the
  comment. An analog from a non-public repo isn't written into a public repo:
  `--write` refuses before writing (without it — a warning), since the other
  task's name and number would stay in the comment's edit history too;
- `--mult 0.5|1.5|2` with `--note "reason"` — a named difference the features
  don't see (in the backtest, agents' corrections on top of the mechanics didn't
  add accuracy; a downward correction against another repo's analogs isn't
  written without `--note`); `--tok-mult 0.5…3` with `--tok-note` — when the
  fan-out differs from the analogs' (parallel subagents shrink hours and grow
  tokens);
- `--hours H` — an expert estimate (confidence C), rounded to the scale; with
  analogs it goes on top of the forecast, and tokens and cost are rescaled in
  proportion.

## Backtest

`est backtest [--repo <r>] [--all-repos]`: every closed task with
an actual is estimated by the mechanics the way the script would have estimated
it on its creation day (analogs — only those closed earlier), and it prints the
share within the ×0.5…×2 tolerance and k for the mechanics, for manual estimates
and for the mechanics with the agent's correction — on one sample (tasks that also
have a manual estimate). It is how a change to the picking rule is checked: the
weights above were chosen with it (#279) — on a history of ~470 tasks the
mechanics lands within tolerance as often as manual picking.

## Actual — how sessions are found

The script finds the task's sessions. First — by pinning: the session in which
`github task status` set the task to In progress (the file
`~/.config/elves/sessions/<session id>` with the line `owner/repo#N`), all of it
— with its subagents (they have the same id) and the time before In progress; the
transcript is looked up by id in any folder of `~/.claude/projects`. A session
pinned to another task doesn't go to this one, whatever features it has — but
a subagent whose assignment names a task («Task #N») does: an executor the
session queued on the owner's "yes" (#546), its records go to task N, not to
the pin. Sessions
without pinning (before it, cloud, Codex, an epic's session, the file deleted) —
by features: the PR's commit hashes in tool outputs, `pr-link` records of its
repository, a branch with the task number, `#N` in the session's name and first
prompt or in a subagent's assignment. Then it computes active hours — including
the work of subagents and workflows inside the session, without waits for input
(section "Waits") — and writes a comment (section "Actual — the comment").

## Waits

The actual is all of the task's time except waits for the user's input
(#518). An interval between neighboring records of one agent ends with input
when its record is a human prompt, the user's command, the app's event, another
session's message, the coordinator's message to a subagent (SendMessage — a
dispatcher's executor waiting for the owner's answer), a tool result the user
approved in the permission dialog (`permissionDecision` with a `user…` source,
not a saved rule) or answered (`AskUserQuestion`, `ExitPlanMode`) — such an
interval isn't the task's time, however long. Not input: a tool result, a
background command's notification and a background subagent's hand-back, the
harness's insertions into a subagent's stream, the user's interrupt.

The rest counts: whole inside a wait call of the same agent — from the call to
its result, a background command — to its notification entering the session's
queue — and up to `--gap` (30 min) otherwise: a longer pause outside a wait is
the machine asleep mid-call or a background process killed days later. Wait
calls by command (heredoc text isn't a command): `wait-ci pr|status` and `gh pr
checks --watch` — CI; `wait-ci merged|issue` — after the merge and the deploy;
`typecheck`, `lint`, `test*`, `e2e` as package scripts, `vitest`, `jest`,
`tsc`, `eslint`, `playwright test` and a command under `slot` — checks, of them
the slot queue (`slot: waited …` in the output; a background command's — from
its output file while it exists). A moment inside calls of two kinds goes to
the first of CI, after the merge, checks; the split is in minutes of the actual
(a shared PR's share too), the rest — the model and the other tools. A
transcript without the permission decision (an older Claude Code, Codex) has
the approval wait inside the call's time — `est fact` prints it as a `○` line.

A session from the folder of another registry repository (the conversation there
grew into a task of this one: the task was created, the session renamed, the
commit and PR are here) is a guest: a candidate only if its transcript contains
the task repository's name, and linked only by this repository's features (the
task's PR and commits, the exact branch of its PR, the issue URL); the number in
the name and in the first prompt counts only together with them, that
repository's branches don't count. Records before the rename stay with that
repository's task, and the "#N …" period with this repository's PR doesn't go to
it. An app session without a chosen folder (a temp folder
`…/Claude/scratch-workspaces/…`) is a guest candidate for any registry
repository: having moved into a repository, it writes its transcript into the
temp folder's directory until the app moves it into the repository's directory.
If it moved into the task repository's folder, it is the repository's own
session, linked like a session from that folder.

## Actual — the comment

`Actual: 3.1 active hours in Claude Code (estimate 3 h, ×1.03). 2 sessions, 14 prompts, 4 subagents, wall clock 10.2 h, coverage full. PR #336; 8 commits, diff 2140 lines.`

("N subagents" — how many subagents worked on the task; a fan-out signal for
picking analogs, `agents` in the marker)

and on a second line — the model spend:

`Tokens: 150.9M (input 0.01 · output 0.18 · cache write 6.4 · cache read 144.3); cost at API rates ≈ $134.61 (claude-opus-5 $83.95, claude-fable-5-1 $50.67).`

and on a third — turns and context (absent if there are no linked model
responses):

`Turns: 250 (subagents 2, their turns 120), preamble 104k, context at the end 581k, turns with context > 400k — 31 %.`

A turn is one model response (by `message.id`); a task's price grows
quadratically with their number: every turn re-reads the whole context. The
preamble is the context of the first top-level turn of the earliest session
(rules and tools), the context at the end — of the last turn of the latest one;
the tail is the share of turns with context over 400k (they were 20 % of turns
and 45 % of tokens). Turns of a shared PR aren't split into shares — each task
gets the whole turn. In the marker — `steps`, `steps_agents`, `tail` (a number),
`preamble`, `ctx_end`.

and on a fourth — the waits, minutes (section "Waits"):

`Waits: CI 4 min · after the merge 4 · checks 6 (slot queue 1) · rest 15.`

In the marker — `waits` (`ci`, `merged`, `checks`, `slot`, `rest`, minutes to a
tenth): `est history` shows them as columns and the medians of the last 10
tasks against the previous 10, the dashboard («Estimate and actual») — as a
tile and columns. The estimate doesn't use them yet.

## Tokens and cost

Besides the comment — the fields «Actual, h», «Tokens, M», «Cost, $» (the last
two — if the project has them). Tokens are taken from `message.usage` of the
same linked records as the time (including subagents), once per `message.id` —
in a transcript, usage repeats on every block of a response, and a resumed
session copies the history. Cost is the **API equivalent** at public rates (the
`PRICES` table at the top of `est.ts`, the date is there too; cache write =
input ×1.25 for a 5-min TTL and ×2 for 1 h; fast mode — at its own rate). On a
subscription this money isn't charged — it is a measure for comparing tasks and
models. The price key is the model id without the date: a date in the id
(`-20251001`, on Vertex AI `@20251101`) doesn't change the rate, while a
different continuation of the name is a different version (`claude-opus-5-5`
with the key `claude-opus-5`), and the previous version's rate doesn't carry
over to it. A new model or your own prices — in the personal
`~/.config/elves/prices.json`: `{"<model id>": [input, output, cache_read]}`; a
model outside the price list gives tokens without a price, and the comment marks
that. Actuals recorded before a rate was fixed are recomputed by
`est fact --sweep --model <id> --write`: closed tasks in the `--since` window
whose spend (the actual marker, `models`) includes this model version, then
their closed epics — an epic adds up the already fixed actuals of its subtasks.
The bulk of tokens is always cache reads — look at the cost and the output, not
the total volume.

## Writing and reruns

Without `--write` everything is only printed — so you can check what the script
found before writing to GitHub. Comments are idempotent: the markers
`<!-- est {…} -->` and `<!-- fact {…} -->` at the end of a comment; a rerun
updates the existing comment instead of adding new ones. `--sweep --write` writes
only tasks with coverage `full`/`partial` — it doesn't mass-post "unavailable";
for a single task `est fact <N> --write` does write «actual unavailable»
(that is the honest record at closing). `--sweep --recompute` rewrites every
recorded actual of the `--since` window, then their epics, by the current
counting (after a change of the actual's definition); an actual whose
transcripts are gone — no sessions or fewer than its marker recorded — stays
as it is, the line says «kept».

A `gh` network failure (timeout, dropped connection, GitHub 5xx) the script
retries with pauses of 2, 5 and 15 s; a request error (404, permissions,
validation) — it doesn't; it doesn't retry a new comment after a dropped response:
GitHub may have accepted it. `--sweep` on one task's error prints `#N: error …`
and moves on; a network that didn't come back within the retries stops
the sweep. With `--write`, at the end — «not written: …» and the
command to retry, exit code 1.

## Double counting and shared commits

Active time is the intervals between neighboring records of one agent — the
session itself or one of its subagents — that are its time (section "Waits"): a dispatcher
session's executors write at the same time, and the neighbor in the session's
common timeline is usually another agent's. Intervals of parallel agents
overlap, so the session's hours, its split by branch and the total are their
union.

One record — one task: the `<!-- fact … -->` marker stores intervals per agent
of a session (`iv`: the key is the session id's 8 characters, for a subagent —
with `:` and the end of its id), and a record linked only by the session name or
the first prompt but already included in a recorded actual of another task by
the same agent isn't counted again — the comment says so: «Not counted again: N h already in the actual of #M».
If that actual is the
wrong one — `est fact M --write`, then this task again. A record linked by
pinning, a branch, a subagent or its own commit stays its own; the overlap is
printed («Overlap with the actual of #M … — recompute #M»). Actuals recorded before `iv` appeared aren't checked;
a marker recorded before the per-agent keys has one key for the whole session
and is compared with the session's own records.
`--sweep` at the end checks the sum of hours against the union of intervals
within each agent of a session: parallel sessions and parallel subagents at the
same time aren't double counting; a warning comes only when records of one agent
went into the actuals of two tasks.

The number is the **issue** number, not a PR's: given a PR number the script
warns and computes the actual for the PR itself. A shared commit/PR that closed
several tasks is split among them equally (the script's output says «unsplit:
N h»; the comment — «shared commit … (share 1/k)»).

## Cloud session import

When the cloud part wasn't counted (old tasks, or the cloud couldn't link the
transcript to the task), a local session imports the session's events; an
export of the same session takes precedence over the part. The import is done
through a browser where the user is signed in to claude.ai (Claude in Chrome):
in a claude.ai tab, run the snippet below — it takes the session's metadata and
all its events and saves `<session>.json` to downloads (the download — with the
user's permission: file name, source, size); then `est cloud-import` and
`est fact <N> --write` (`SKILL.md`, "Cloud session").

```js
// in a claude.ai tab; save=false — summary only, no download
async function cloudExport(session, save) {
  const h = { "anthropic-version": "2023-06-01" };
  const get = async (u) => { const r = await fetch(u, { headers: h }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
  const meta = await get(`/v1/code/sessions/${session}`);
  const m = meta.response_shape ?? meta;
  const events = [];
  for (let cur = null, i = 0; i < 1000; i++) {
    const j = await get(`/v1/code/sessions/${session}/events` + (cur ? `?cursor=${encodeURIComponent(cur)}` : ""));
    events.push(...j.data);
    if (!j.next_cursor || !j.data.length) break;
    cur = j.next_cursor;
  }
  const repo = String(m.config?.sources?.[0]?.url ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const out = { v: 1, session, repo, title: m.title ?? "", events };
  const json = JSON.stringify(out);
  if (save) Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: `${session}.json` }).click();
  return { repo, title: out.title, events: events.length, bytes: json.length };
}
await cloudExport("session_…", true)
```

A cloud session is counted by the same rules as a local one: the name "#N …"
links, the branch comes from commit events (before the first commit — neutral),
the human is the client's prompts, tokens — once per response, subagents — by
their own streams. The export is personal (prompts, tool outputs) — only in the
state folder, not in the repository.

## Period summary

A task's actual sees only the work linked to the task. In a flow without tasks (a
PR without an issue, a worktree branch before the rename, a shared branch of
several PRs) it is understated or split wrongly — you can't compare the flow
before and after a change by it. `est period` takes all of the repo's sessions
over the period, without linking.

A period is a pair `--since … [--until …]` (the i-th `--until` closes the i-th
`--since`; without it — up to now; a date `YYYY-MM-DD` is midnight local time, or
an ISO time, or `90d`). Sessions come from the repo's folders, including short
ones without commits (the actual discards them as routines), and those pinned to
its tasks; no guests (sessions of another repo). Agent time is counted as in the
actual (section "Waits"), a session's agents — by their union. The script prints the totals and
the same per PR merged in the period: agent hours (sum over sessions), machine
hours (union of sessions) and their ratio — parallelism, tokens, output, $, turns,
subagents, human prompts, $ per 1M tokens; for two periods — the «after / before»
ratio, and below the table — the $ share by model for each
period.

**$ is flow × model rate.** A model change changes $ per PR several-fold with the
same flow; the flow's effect shows in tokens, output and hours per PR, a rate
shift — in «$ per 1M tokens» and the $ share by model
(`est history` prints it too). Work on a PR may have started before the period —
compare periods longer than a typical task.

## Linking — details

- The session name `#<number> <task title>` is read from the transcript and
  links from the moment of the rename: the first name applies from the start of
  the session, each next one — from its rename. That's how old sessions that ran
  tasks one after another are split: records on a branch without a number go to
  the task under whose name they were made, not to the last one.
- The branch `<type>/<issue>-<slug>` may have an area prefix:
  `backend/fix/42-…`; the old `issue-42-…` is recognized too.
- Subagent transcripts count as part of the session, and the number in the
  assignment links their work to its task even when several tasks run in
  parallel (without a number, parallel work is split by commit order —
  roughly). The task is the number after the word «Task» or at the very start
  of the assignment (`Task #263 (epic #250). …`, `#263 …`); a number after
  «epic» isn't the task; two numbers without these markers
  (`look at #263 and #261`) give no hint.
- A transcript record's branch is the branch of the session's folder, so work
  in a neighboring worktree from the same session is on a "foreign" branch. A
  subagent working in its own worktree (its folder isn't one of the session's)
  gets that worktree's branch, read from its git files: Claude Code writes into
  such a record's `gitBranch` the branch of another checkout. A worktree
  already removed gives no branch (neutral) — its records are linked by the
  task number in the assignment. The other way too: a record in the session's
  folder (the session's own, or a subagent continued there after its worktree
  was removed) whose `gitBranch` is the branch of one of its subagents'
  worktrees is neutral — a dispatcher's records carry its executors' branches.
  A worktree's branches are the one checked out now and those the subagent's
  own output switched to there (`Switched to branch`, a commit line, `+ branch
  … → …` of `github task status --branch`): a removed worktree leaves only the
  output.
- A subagent's own worktree is a separate checkout: a commit hash in the output
  of a subagent working there, and a PR the app bound to the session from one of
  that worktree's branches, open windows only for that worktree's records, with
  its branch — a dispatcher's own records next to its executor's commit or PR
  don't go to the executor's task. Coverage (whether the PR is seen) still counts
  every commit.
- A hash in a listing's output (`git worktree list`, `git branch`, `git log`,
  `git fetch`, reading via `gh` other than `gh pr view`; a command made only of
  these and utilities like `head`, `grep`, including inside a `for` or `while`
  loop and an `if` condition) links only if that commit is also in the own
  output of the same checkout (the session's folders or that subagent's
  worktree): `git log` of a neighboring worktree doesn't hand the session's time
  to someone else's task, nor does the session's `git worktree list` with a
  commit its subagent made in its own worktree.

## Codex sessions

Codex sessions (`~/.codex/sessions/**/*.jsonl`, `archived_sessions`) are read
the same way: prompts — `UserMessage`, commit hashes — from tool outputs,
tokens — `token_usage_record` (once per response); records have no branch, so
linking is by the number in the first prompt and by commit hashes. `gpt-*`
models aren't in the price list — tokens are counted, the cost is marked
«no price» until it is set in `prices.json`.
