/**
 * Запись ответов GitHub для фикстур теста скилла github — только чтения, мутации запрещены:
 *   bun tests/lib/github-record.ts owner/repo <out.json> [шаблон owner/N]
 * Пишет всё, что читает `project check`, плюс поиск проекта по названию и эталон. Не спека.
 */
import { writeFileSync } from "node:fs";

import { graphql, main, Q, realGh } from "../../skills/github/scripts/github.ts";
import type { Io } from "../../skills/github/scripts/github.ts";
import { keyOf, opOf } from "./fake-github.ts";
import type { Recording } from "./fake-github.ts";

const [slug, out, template = "miroshnik/6"] = process.argv.slice(2);
if (!slug || !out) throw new Error("usage: bun tests/lib/github-record.ts owner/repo <out.json> [owner/N]");

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
writeFileSync(out, JSON.stringify(rec, null, 1) + "\n");
console.log(`записано ${Object.keys(rec).length} ответов → ${out}`);
