<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# package-manager

Менеджер пакетов проекта во флоу определяет одна функция: на вопрос «какой менеджер пакетов у проекта» отвечает
`packageManager(dir)` скилла `github` по одной таблице случаев, а `pr premerge`, обёртка slot и раннер готовой строки
`test:spec` у `check` берут ответ у неё.

Ответ нужен трём местам. `pr premerge` ставит зависимости слияния и зовёт скрипты проекта (`projectCommands`);
установка оборачивает проверки `package.json` в очередь slot — на Yarn 2+ строкой у `slot.ts`: его shell не подключает
`slot.sh`; `check` предлагает строку `test:spec` с `bun test` в проекте на Bun, когда раннер не дают ни команда `test`,
ни зависимости. Три копии правила были связаны только смыслом и разошлись: `packageManager: "pnpm@…"` и забытый
`bun.lock` — `premerge` звал `pnpm run`, а `check` предлагал `bun test`; забытый `.yarnrc.yml` переключал обёртку slot
на shell Yarn при любом менеджере, а `premerge` его не видел вовсе. Ошибка видна поздно и в чужом проекте: не та
команда установки на слиянии или не тот раннер в готовой строке. Копии здесь не нужны, в отличие от стандартов-копий
(`task-branch`): ответ нужен самому `github` и установщику `bin/elves.ts`, а установщик — не скилл и уже импортирует
`github.ts` (граф импортов скиллов — стандарт `skill-imports`).

## Правило

- менеджер — `packageManager` в `package.json` (`bun@`, `pnpm@`, `yarn@`, `npm@`): он сильнее файлов;
- без него — lockfile, по порядку: `bun.lock` и `bun.lockb` — bun, `pnpm-lock.yaml` — pnpm, `yarn.lock` — Yarn,
  `package-lock.json` — npm;
- без обоих — `.yarnrc.yml`: Yarn; ничего из этого — npm;
- Yarn 2+ — скрипты в своём shell: `yarn@2` и старше в `packageManager`, а Yarn по файлам — с `.yarnrc.yml`; версию
  решает `packageManager`: `yarn@1.22.22` с `.yarnrc.yml` — Yarn 1, `pnpm@…` с `.yarnrc.yml` — pnpm (#485, вопрос 1);
- lockfile, по которому `premerge` ставит зависимости, — свой у менеджера, иначе первый по порядку; ни одного — без
  установки.

Реестр ответов — скрипты скиллов, которые экспортируют `packageManager`; каждый сверяется с таблицей. Скрипт флоу
(`skills`, `bin`) не читает поле `packageManager` из `package.json` и не называет lockfile или `.yarnrc.yml` строкой
мимо этой функции: их место — тело `packageManager` в `github.ts`. Список lockfile в `est.ts` (`DIFF_EXCLUDE`) —
файлы вне счёта диффа, а не менеджер пакетов: это регулярка путей, правило её не касается.

## Менеджер пакетов проекта отвечает одна функция: packageManager в package.json сильнее lockfile, без обоих — npm, .yarnrc.yml — Yarn 2+

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «скрипты скиллов с ответом на «какой менеджер пакетов у проекта»» не пуст
- ✅ реестр «скрипты скиллов с ответом на «какой менеджер пакетов у проекта»» находит skills/github/scripts/github.ts
- ✅ нарушитель не проходит: раннер test:spec до стандарта: bun.lock сильнее packageManager
- ✅ нарушитель не проходит: обёртка slot до стандарта: .yarnrc.yml — shell Yarn 2+ при любом менеджере
- ✅ skills/github/scripts/github.ts: менеджер пакетов проекта — по таблице правила
- ✅ таблица ловит расхождения копий до стандарта: забытый bun.lock у раннера test:spec, забытый .yarnrc.yml у обёртки slot

</details>

## Менеджер пакетов у premerge, обёртки slot и раннера test:spec у check — ответ packageManager

<details><summary>✅ 1 тест</summary>

- ✅ premerge, обёртка slot и раннер test:spec у check берут менеджер пакетов у неё: packageManager pnpm и забытые bun.lock и .yarnrc.yml — premerge зовёт pnpm, обёртка slot — через slot.sh, check не предлагает bun test

</details>

## Скрипт флоу не читает packageManager и не ищет lockfile мимо функции packageManager

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «скрипты флоу, которые читают поле packageManager или называют lockfile» не пуст
- ✅ реестр «скрипты флоу, которые читают поле packageManager или называют lockfile» находит skills/github/scripts/github.ts
- ✅ нарушитель не проходит: скрипт флоу читает packageManager мимо этой функции
- ✅ нарушитель не проходит: скрипт флоу ищет lockfile мимо этой функции
- ✅ нарушитель не проходит: вторая функция packageManager в другом скрипте
- ✅ skills/github/scripts/github.ts: поле packageManager и lockfile — только в теле packageManager github

</details>
