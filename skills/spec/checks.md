# Проверки скилла spec — харнесс, модель архитектуры, журнал точек входа

Справочник к разделу «Проверки» в `SKILL.md`: как подключить каждую механическую проверку в тестах проекта.


Механическая проверка — это тесты раннера: они в отчёте, а значит в
`docs/spec` и в `spec-diff`. Харнесс не зависит от раннера — `it` передаёт
тест (Vitest, Jest, bun test, `node:test`). Импорт — из копии скилла в
проекте: `.agents/skills/spec/scripts/harness.ts` (из
`tests/standards/<name>/` — `../../../.agents/skills/spec/scripts/harness.ts`).

**`invariant` — реестр + инвариант.** Соглашение о поведении («каждая
мутация пишет аудит», «каждый маршрут проверяет право») проверяется на каждом
элементе реестра, взятого из кода, а не на одном примере:

```ts
import { describe, expect, it } from "vitest";
import { invariant } from "../../../.agents/skills/spec/scripts/harness.ts";

const mutations = await listMutations(); // из кода: роутер, схема, файлы — не рукописный список

describe("каждая мутация пишет аудит", () => {
  invariant(it, {
    registry: "мутации",
    items: mutations,
    name: (m) => `${m.name} пишет запись аудита`,
    check: async (m) => expect(await auditRowsAfter(m)).toHaveLength(1),
    violator: { name: "мутация без записи аудита", item: fakeMutationWithoutAudit },
  });
});
```

Тесты: «реестр «мутации» не пуст» — опечатка в пути или выборке даёт пустой
реестр и зелёную проверку, которая ничего не проверяет; «нарушитель не
проходит: …» — проверка обязана упасть на заведомом нарушителе; по тесту на
элемент с названием-утверждением; тесты элементов идут по названию, а не в
порядке реестра — порядок файлов и запросов зависит от машины, а `docs/spec`
не должен. Счётчиков в названиях нет: реестр растёт — в `spec-diff` только
новые элементы. Реестр считается до регистрации тестов:
асинхронный — `await` на верхнем уровне файла.

**`examples` — примеры линт-правила.** Правило проверяется кодом, на котором
оно обязано сработать («нельзя»), промолчать («можно») и не действовать
(«вне охвата» — файл, на который правило не распространяется). Линтер — через
адаптер: `eslintLinter()` берёт ESLint и `eslint.config.*` проекта, пример
проверяется так же, как `lint` проверит файл по этому пути.

```ts
import { describe, it } from "vitest";
import { eslintLinter, examples } from "../../../.agents/skills/spec/scripts/harness.ts";

describe("домен не пишет в консоль", () => {
  examples(it, {
    linter: eslintLinter(),
    rule: "no-console",
    bad: [{ name: "console.log в домене", path: "src/domain/invoice.ts", code: "console.log(1);" }],
    good: [{ name: "логгер в домене", path: "src/domain/invoice.ts", code: "log.info(1);" }],
    outside: [{ name: "console.log в скрипте сборки", path: "scripts/build.ts", code: "console.log(1);" }],
  });
});
```

Тесты — «нельзя: …», «можно: …», «вне охвата: …». Срабатывание другого
правила не считается ни за, ни против; пример, который не разбирается, —
упавший тест; без «нельзя» — упавший тест «у правила … есть пример
«нельзя»». Адаптер пока один — ESLint: ast-grep и Biome добавятся, когда
понадобятся проекту (ядро от линтера не зависит, `Linter` — интерфейс из
одного метода).

**Правило — в папке своего стандарта.** Фрагмент flat config — `eslint.ts`
рядом с тестом (`export default [{ files: ["src/domain/**"], rules: {…} }]`,
пути от корня проекта); `eslint.config.*` проекта только собирает фрагменты
дерева — `lint` и редактор видят правило как обычно:

```js
import { collectEslint } from "./.agents/skills/spec/scripts/eslint-config.ts";
export default [...base, ...(await collectEslint(import.meta.dirname))];
```

ESLint кэширует конфиг в процессе: новый или удалённый фрагмент редактор
увидит после перезапуска ESLint-сервера; `lint` в CLI — сразу.

**Исключения — явные, с задачей, и уходят, когда больше не нужны.**

- *Реестр + инвариант:* `exceptions.ts` в папке решения —
  `export default [{ item: "importLegacy", issue: 12, reason: "…" }]`, в
  `invariant` — `exceptions` и `key` (стабильный идентификатор элемента: имя,
  путь). Исключённый элемент вместо обычного теста получает «исключение:
  <ключ> (#N)»: зелёный, пока нарушает соглашение; начал соблюдать — красный
  «убери исключение» (храповик: долг только уменьшается). Исключение без
  задачи, без причины или на элемент вне реестра — красный.
- *Линт-правило:* исключение — отключение в коде, там же, где нарушение:
  `// eslint-disable-next-line no-console -- #12 причина`. `collectEslint`
  включает `reportUnusedDisableDirectives: "error"` — отключение, которое
  больше ничего не глушит, — ошибка `lint`. Формат проверяет стандарт проекта:

  ```ts
  import { it } from "vitest";
  import { lintExceptions } from "../../../.agents/skills/spec/scripts/harness.ts";

  lintExceptions(it, { root: process.cwd(), dirs: ["src"] });
  ```

  По тесту на файл с отключениями («исключения в <файл>: <правила>»): у
  каждого отключения названо правило и есть `-- #N причина`; общий
  `eslint-disable` без правил запрещён — он глушит и правила, и проверку
  внутри линтера, поэтому формат проверяет тест, а не правило ESLint. Тесты
  файлов — список исключений в спеке.

**Модель архитектуры — `architecture.ts`.** Одна на проект,
`tests/architecture/model.ts`: модули (путь, назначение), от каких модулей и
внешних пакетов каждый зависит.

```ts
import type { Model } from "../../.agents/skills/spec/scripts/architecture.ts";

export default {
  roots: ["src"],
  aliases: { "@/": "src/" }, // импорт по псевдониму — локальный, не пакет
  modules: {
    domain: { path: "src/domain", purpose: "правила счетов, без ввода-вывода" },
    infra: { path: "src/infra", purpose: "база и сервисы", dependsOn: ["domain"], packages: ["pg"] },
  },
} satisfies Model;
```

- *Границы модулей* — `tests/architecture/boundaries/eslint.ts`:
  `export default boundariesConfig(model, boundaries)` (плагин
  `eslint-plugin-boundaries` проекта; для псевдонимов TypeScript — резолвер
  через `settings`). Импорт модуля не из `dependsOn` — ошибка
  `boundaries/dependencies` в `lint` и редакторе; в `boundaries.test.ts` —
  `examples` на это правило.
- *Модель против кода* — `architecture(it, { root, model })` в
  `tests/architecture/modules/modules.test.ts`: «<каталог> → <модуль>» на
  каждый каталог кода (вне модулей — красный), «<модуль> импортирует <пакет>»
  (пакет не разрешён модулю — красный), «<модуль> использует разрешённый
  пакет <пакет>» (не импортируется — красный: модель разошлась с кодом).
  Импорты — статический разбор: относительные, псевдонимы, встроенные модули
  Node и `import type` — не пакеты. Пакеты проверяет разбор, а не плагин:
  `eslint-plugin-boundaries` 7.2 внешние пакеты не ловит даже явным запретом.

**Точки входа — `journal` и `spec-claims`.** Каждая точка входа (маршрут,
страница, job, команда) вызывается хотя бы одним тестом capability — по
журналу вызовов, а не по покрытию (покрытие говорит «выполнилось», а не
«вызвано заявленным поведением»).

- *Журнал:* тестовая сборка оборачивает роутер или обработчики —
  `journal("POST /invoices")` из `harness.ts`. Файл теста определяется по стеку;
  где стека теста нет (e2e: запрос приходит в сервер), — явно:
  `journal(id, { test: test.info().file })` у Playwright. Запись —
  `.spec-journal/<процесс>.jsonl` (`SPEC_JOURNAL` — другой каталог; в
  `.gitignore`).
- *Реестр:* точки входа из кода — JSON-массив или модуль проекта
  (`export default async () => [...]`: маршруты из файлов роутера, jobs из
  реестра). Рукописный список не годится: новая точка проскочит.
- *Сверка — после прогона всех тестов и шардов* (журналы шардов — в один
  каталог артефактами):

  ```bash
  node .agents/skills/spec/scripts/spec-claims.ts --entries tests/standards/entry-points/entries.ts [--exceptions tests/standards/entry-points/exceptions.ts]
  ```

  Тесты «<точка> вызывается тестом capability» — вызов из
  `tests/capabilities/` (из стандарта или хелпера не засчитан); «реестр
  «точки входа» не пуст»; «исключение: <точка> (#N)» — зелёное, пока теста
  нет, появился — «убери исключение». Код 1 при незаявленных. Отчёт —
  `.spec-claims.xml` (JUnit) в папке стандарта `tests/standards/entry-points`
  (`--standard`): передай его в `spec-doc` вместе с отчётами раннеров — сверка
  попадёт в спеку с описанием `entry-points.md` стандарта.

**Код без потребителя — `deadCode` (knip).** Файл, экспорт или зависимость, до
которых не доходит ни одна точка входа, — мёртвый код: knip находит его по
графу импортов (точки входа knip — из его конфига проекта).

```ts
import { it } from "vitest";
import { deadCode } from "../../../.agents/skills/spec/scripts/harness.ts";
import exceptions from "./exceptions.ts";

deadCode(it, { root: process.cwd(), exceptions }); // или report: ".knip.json" — готовый `knip --reporter json`
```

Тесты по видам — «нет файлов без потребителя», «нет экспортов без
потребителя», «нет типов без потребителя», «нет зависимостей без импорта»,
«нет импортов неустановленных пакетов», «нет нерезолвящихся импортов» —
упавшие со списком находок. Исключение — ключ находки (`file:src/legacy.ts`,
`export:src/math.ts#factorial`, `dependency:lodash`) с задачей: зелёное, пока
knip его находит; перестал — «убери исключение». Без `report` запускается
`node_modules/.bin/knip --reporter json` проекта.

**Переменные окружения — `envVars`.** Переменная, которую читает код
(`process.env.X`, `process.env["X"]`, `import.meta.env.X`,
`const { X } = process.env`), объявлена в схеме окружения; объявленная —
читается. `declared` — из схемы проекта (ключи zod-схемы, t3-env,
`.env.example`):

```ts
envVars(it, { root: process.cwd(), dirs: ["src"], declared: Object.keys(envSchema.shape) });
```

Тесты «<VAR> объявлена» и «<VAR> читается в коде»; служебные (`NODE_ENV`,
`CI`, `PORT`… и `ignore`) — вне проверки.

**Код примеров и причины исключений — в спеке.** Харнесс при регистрации
тестов пишет метаданные прогона — `.spec-meta/<процесс>.jsonl` (`SPEC_META` —
другой каталог): у примера `examples` — путь и код, у исключения (`invariant`,
`deadCode`, `lintExceptions`) — задача и причина. `spec-doc` берёт их из
`.spec-meta` в корне (или `--meta`) и показывает под строкой теста: соглашение
видно кодом, долг — задачами. Метаданные шардов CI складывает в один каталог,
как журнал точек входа (`ci.md`).

**Внешние системы (C1) — `externals` в модели.** Модель называет каждую
внешнюю систему и её модуль-адаптер:

```ts
externals: {
  payments: { purpose: "платежи картой", adapter: "stripe", hosts: ["api.stripe.com"], packages: ["stripe"], env: ["STRIPE_KEY"] },
},
```

`architecture` тогда добавляет: «хост <h> — только в адаптере <a>» (литерал
URL вне адаптера или хост вне модели — красный), «пакет <p> внешней системы
<x> — только у адаптера <a>» (модель без противоречий), «ключ <K> внешней
системы <x> читает только адаптер <a>». В настройке тестов —
`globalThis.fetch = networkGuard(model, globalThis.fetch)`: запрос к хосту вне
модели падает (локальные адреса — можно), объявленные хосты мокают как
обычно. Заголовок CSP браузера — `cspConnectSrc(model)`: тест проекта сверяет
с ним свой `connect-src`, и новый хост без модели в браузер не попадёт.

**Контейнеры (C2) — `containers` в модели.** Развёртываемые единицы и связи
между ними:

```ts
containers: {
  app: { purpose: "веб-приложение", modules: ["web", "domain", "repo"], deploy: ["compose:app"], uses: ["db"] },
  mail: { purpose: "отправка писем", modules: ["mailer"], deploy: ["supabase-function:send-email"] },
  db: { purpose: "база", deploy: ["compose:db"], clients: ["pg"] },
},
```

`architecture` тогда добавляет: «модуль <m> — в контейнере <c>» (ни в одном
или в нескольких — красный), «зависимость <a> → <b> — внутри контейнера»
(между контейнерами — только связь `uses`), «развёртываемая единица <id> —
контейнер <c>» (единица из конфигов без модели и контейнер модели без
конфига — красные), «клиент <pkg> хранилища <s> — в контейнере <c>» (без
`uses` к хранилищу — красный). Развёртываемые единицы (`deployUnits`) —
сервисы `docker-compose.yml` / `compose.yml`, `supabase/functions/<имя>`,
crons в `vercel.json`; другие форматы добавятся, когда понадобятся проекту.
Дрейф прода относительно конфигов этими проверками не ловится.

