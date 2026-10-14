Состояние check-run головы PR `github` и `ci-wait` читают одинаково: на вопрос «какое состояние у чека `<имя>`» по его
check-runs — status, conclusion и перезапуски — оба скрипта отвечают по одной таблице, а запросы `github` берут чеки
головы одним фрагментом.

Состояние чека читают три места: `task show` (✅, ⏳, ❌ у PR задачи), `project check` (требуемые чеки — зелёные на
каждом из последних влитых PR) и `wait-ci.sh` (PASS или FAIL ожидания). Правило жило в трёх копиях, связанных только
смыслом, и они разошлись (#492): из перезапусков `task show` брал лучший прогон, `project check` — любой зелёный,
`wait-ci.sh` — последний. Чек зелёный, потом красный на перезапуске — `task show` показывал ✅, а ожидание давало FAIL:
агент видит зелёный PR, который не влить. Теперь в `github.ts` правило одно — `checkStates`, его берут и `task show`, и
`project check`; копия — `CHECK_STATES` в `skills/ci-wait/scripts/wait-ci.sh`. Общего модуля нет: `github` и `ci-wait`
других скиллов не импортируют (стандарт `skill-imports`), а `wait-ci.sh` — bash и jq, импорта TypeScript у него нет.

## Правило

Состояния — корзины `gh pr checks`: `pass`, `skipping`, `pending`, `cancel`, `fail`.

- check-run не завершён (`queued`, `in_progress`, `waiting`) — `pending`;
- завершён: `success` — `pass`; `neutral` и `skipped` — `skipping`; `cancelled` — `cancel`; остальное (`failure`,
  `timed_out`, `action_required`, `startup_failure`, `stale`) — `fail`;
- перезапуски одного имени — решает последний check-run (больший id), а не лучший и не место в ответе API;
- одно имя у разных приложений — порознь: у каждого его последний check-run, а имя получает худшее из их состояний
  (`fail`, `cancel`, `pending`, `skipping`, `pass`) — упавший чек одного приложения не скрыть зелёным другого.

Что из состояния следует, решает читатель. `task show`: `pass` и `skipping` — ✅, `cancel` и `fail` — ❌. `wait-ci.sh`:
FAIL на `fail` и `cancel`. `project check` строже: требуемым он предлагает только `pass` — пропущенный по условию или
нейтральный чек ничего не проверил. Строгость — своя строка таблицы (`skipping` отдельно от `pass`), а не третья копия
правила.

Реестр копий — скрипты скиллов с правилом: `export function checkStates` в `.ts` и `CHECK_STATES='…'` в `.sh`. Каждая
отвечает по таблице в формате своего API и своим движком: `checkStates` — узлы `statusCheckRollup` GraphQL (перечисления
в верхнем регистре, id — `databaseId`, приложение — `checkSuite.app.databaseId`), `CHECK_STATES` — определение jq
`check_states` над check-runs REST, как в `wait-ci.sh`.

Выборка чеков головы — фрагмент `HEAD_CHECKS` в `github.ts`: каждый запрос `Q` со `statusCheckRollup` берёт его. Без id
прогона и приложения в выборке перезапуски не различить, и правило молча читало бы порядок ответа.

Вне правила. Статусы коммита (хостинг) GitHub сам сводит к последнему на контекст: `success` — `pass`, `pending` (и
`EXPECTED` GraphQL) — `pending`, остальное — `fail`. `github pr premerge` спрашивает другое — красный ли `main`: из
перезапусков он тоже берёт последний, но отменённый прогон и ждущий решения человека красным `main` не считает.
