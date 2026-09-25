# GitHub: команды к правилам ведения задач

Справочник к разделу «Ведение задач» в `AGENTS.md`. Все примеры — с
вымышленными владельцами и номерами.

## Типы issue (организация)

Ровно три типа: «Задача», «Баг», «Эпик». В новой организации (нужен scope
`admin:org`): `gh api orgs/<org>/issue-types` — переименовать Task→Задача,
Bug→Баг (`gh api -X PUT orgs/<org>/issue-types/<id> -f name=Баг -F is_enabled=true`), Feature
выключить, добавить Эпик (`-f name=Эпик -f color=purple -F is_enabled=true`).

```bash
gh issue create --title "…" --body-file body.md --type Задача
gh api -X PATCH repos/{owner}/{repo}/issues/<N> -f type=Баг
gh issue list --json number,issueType --jq '.[]|select(.issueType.name=="Эпик")'
```

## Приоритет — поле issue `Priority` (организация)

```bash
# id поля и опций: … on IssueFieldSingleSelect{id name options{id name}}
gh api graphql -f query='{organization(login:"<org>"){issueFields(first:10){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}'
# поставить: issueId — node_id issue
gh api graphql -f query='mutation{setIssueFieldValue(input:{issueId:"<node_id>",issueFields:[{fieldId:"<field id>",singleSelectOptionId:"<option id>"}]}){issue{number}}}'
# прочитать: issue.issueFieldValues{nodes{... on IssueFieldSingleSelectValue{field{... on IssueFieldCommon{name}} name}}}
# подключить поле в проект как есть:
# createProjectV2IssueField(input:{projectId, issueFieldId})
```

## Подзадачи эпика (sub-issues)

```bash
SUB_ID=$(gh api repos/{owner}/{repo}/issues/<номер-подзадачи> --jq .id)   # id, не номер!
gh api repos/{owner}/{repo}/issues/<номер-эпика>/sub_issues -X POST -F sub_issue_id=$SUB_ID
gh api repos/{owner}/{repo}/issues/<номер-эпика>/sub_issues                # список подзадач
```

## Зависимости (blocked by / blocking)

```bash
BY_ID=$(gh api repos/{owner}/{repo}/issues/<блокер> --jq .id)              # id, не номер!
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -X POST -F issue_id=$BY_ID
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by             # кто блокирует N
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocking               # кого блокирует N
gh api -X DELETE repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by/$BY_ID
```

## Проект (GitHub Projects)

### Проверка

```bash
# проект привязан к репо? какие представления? какие поля?
gh api graphql -f query='{repository(owner:"<owner>",name:"<repo>"){projectsV2(first:5){nodes{number title}}}}'
gh api graphql -f query='{organization(login:"<owner>"){projectV2(number:<N>){views(first:10){nodes{id name layout filter}}}}}'   # личный аккаунт — user(login:)
gh project field-list <N> --owner <owner> --format json
gh project view <N> --owner <owner> --format json    # id проекта
```

У представлений `filter` пуст: фильтр (например, `iteration:@current` без
поля Iteration) молча прячет задачи с доски. Снять —
`updateProjectV2View(input:{viewId,filter:""})`.

Встроенные workflow проекта **«Item added to project» → `Бэклог`** и
**«Item closed» → `Готово`** включены — страховка статуса, когда ставить его
некому (облачная сессия, другой агент, закрытие из UI GitHub). На «Item
closed» держится статус задач, закрытых из облачной сессии: поля проекта ей
недоступны (`docs/cloud-sessions.md`). API отдаёт у workflow только `name` и
`enabled`: включить его и прочитать, какой статус он ставит, нельзя.
Workflow, которого нет в списке, ни разу не настраивался — он выключен (у
нового проекта в списке только «Item closed», «Pull request merged» и
«Auto-close issue»). Цель «Item closed» видна по результату: закрытая
задача в проекте не в `Готово` — workflow выключен или указывает на
удалённый вариант `Status` (после замены вариантов, раздел ниже).

```bash
# workflow: true — включён, false или строки нет — выключен (личный аккаунт — user(login:))
gh api graphql -f query='{organization(login:"<owner>"){projectV2(number:<N>){workflows(first:20){nodes{name enabled}}}}}' \
  --jq '.data.organization.projectV2.workflows.nodes[]|"\(.enabled) \(.name)"'
# закрытые задачи в проекте не в «Готово» — номера; пусто — «Item closed» работает
gh api graphql -f query='{organization(login:"<owner>"){projectV2(number:<N>){items(last:100){nodes{content{... on Issue{number state}} status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}' \
  --jq '.data.organization.projectV2.items.nodes[]|select(.content.state=="CLOSED" and .status.name!="Готово")|.content.number'
```

Выключен или ставит не то — включает пользователь, только в UI: проект →
⋯ → Workflows → «Item added to project» (Set value: `Status` → `Бэклог`) и
«Item closed» (`Status` → `Готово`) → Save and turn on workflow. Закрытым
задачам не в `Готово` статус ставит агент.

### Создание с нуля

- Проще всего скопировать уже настроенный проект:
  `copyProjectV2(input:{projectId, ownerId, title:"<repo>"})` (`ownerId` —
  node ID владельца: `{organization(login:"…"){id}}` или `{viewer{id}}`);
  представления и поля скопируются, задачи — нет. Копировать нечего —
  `gh project create --owner <owner> --title "<repo>"`.
- Привязать к репо: `gh project link <N> --owner <owner> --repo <owner>/<repo>`.
- У свежесозданного проекта уже есть поле `Status` (`Todo / In Progress /
  Done`) и представление `View 1`. Варианты `Status` не добавляем, а
  **заменяем целиком** (`color` и `description` обязательны):
  `updateProjectV2Field(input:{fieldId:"…",singleSelectOptions:[{name:"Бэклог",color:GRAY,description:""},{name:"В работе",color:YELLOW,description:""},{name:"Готово",color:GREEN,description:""}]})`.
  `View 1` переименовать в `Таблица` (`updateProjectV2View(input:{viewId,name})`),
  `Доска` и `Роадмэп` создать: `createProjectV2View(input:{projectId,name,layout:BOARD_LAYOUT})`
  / `ROADMAP_LAYOUT`. Группировка доски по `Status` — дефолт, через API не
  настраивается (и не нужно); сортировка `Таблица` и `Доска` по `Priority`,
  поля дат и маркеры milestones у роадмэпа через API не задаются — после
  создания попросить пользователя настроить их один раз в UI, вместе с
  workflow «Item added to project» → `Бэклог` и «Item closed» → `Готово`
  (замена вариантов `Status` оставляет «Item closed» на удалённом `Done`).
- Числовые поля:
  ```bash
  gh project field-create <N> --owner <owner> --name "Оценка, ч" --data-type NUMBER
  gh project field-create <N> --owner <owner> --name "Факт, ч" --data-type NUMBER
  gh project field-create <N> --owner <owner> --name "Токены, млн" --data-type NUMBER
  gh project field-create <N> --owner <owner> --name "Стоимость, $" --data-type NUMBER
  ```

### Задача в проекте

```bash
ITEM=$(gh project item-add <N> --owner <owner> --url <issue-url> --format json --jq .id)
gh project item-edit --id $ITEM --project-id <project-id> --field-id <id-поля-Status> --single-select-option-id <id-варианта>
gh project item-edit --id $ITEM --project-id <project-id> --field-id <id-поля-Оценка> --number 4
gh project item-delete <N> --owner <owner> --id $ITEM        # закрыта без выполнения
gh issue close <N> --reason "not planned"
```

ID проекта, полей и вариантов — `gh project view` / `gh project field-list`
(в JSON `gh project item-list` ключи кириллических полей искажены — не
полагаться на них; скилл `est` ищет поля по точному имени через GraphQL).

## Milestones

```bash
gh api -X GET repos/{owner}/{repo}/milestones -f state=all           # список
gh api repos/{owner}/{repo}/milestones -f title="Биллинг · 1 · Проектирование" -f description="Эпик: #42"
gh issue edit <N> --milestone "Биллинг · 1 · Проектирование"
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```
