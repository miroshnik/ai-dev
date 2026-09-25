/**
 * Запись ответов GitHub для фикстур теста скилла github — только чтения, мутации запрещены:
 *   bun tests/lib/github-record.ts miroshnik/ai-dev tests/lib/github-ai-dev.json --issues 42,45,46,47,49
 * Пишет всё, что читает `project check`, поиск проекта по названию, эталон, контекст задач (метка epic,
 * milestones) и задачи из --issues. Не спека.
 */
import { writeFileSync } from "node:fs";

import { graphql, main, Q, realGh } from "../../skills/github/scripts/github.ts";
import type { Io } from "../../skills/github/scripts/github.ts";
import { keyOf, opOf } from "./fake-github.ts";
import type { Recording } from "./fake-github.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--issues");
const issues = at < 0 ? [] : argv.splice(at, 2)[1]!.split(",").map(Number);
const [slug, out, template = "miroshnik/6"] = argv;
if (!slug || !out) throw new Error("usage: bun tests/lib/github-record.ts owner/repo <out.json> [owner/N] [--issues 42,45]");

const rec: Recording = {};
const io: Io = {
  gh: (args, stdin) => {
    const { query, variables } = JSON.parse(stdin ?? "{}");
    const { kind, op } = opOf(query);
    if (kind !== "query") throw new Error(`запись — только чтения, а не ${op}`);
    const res = realGh(args, stdin);
    rec[keyOf(op, variables)] = JSON.parse(res);
    return res;
  },
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  env: {},
};
main(["project", "check", "--repo", slug], io);
const [owner, name] = slug.split("/");
graphql(io, Q.OwnerProjects, { login: owner, query: name });
const [login, number] = template.split("/");
graphql(io, Q.TemplateProject, { login, number: Number(number) });
graphql(io, Q.TaskContext, { owner, name });
for (const n of issues) graphql(io, Q.IssueRef, { owner, name, number: n });
writeFileSync(out, JSON.stringify(rec, null, 1) + "\n");
console.log(`записано ${Object.keys(rec).length} ответов → ${out}`);
