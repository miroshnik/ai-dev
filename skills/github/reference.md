# github — ручные команды

То, чего нет в командах скилла: правка уже созданной задачи и milestones.
Создание задачи, статус и закрытие без выполнения — `task new`, `task status`,
`task drop` (`SKILL.md`). Примеры — с вымышленными владельцами и номерами.

## Типы issue

В организации типы проверяет и настраивает `project fix --confirm`
(Task → Задача, Bug → Баг, Эпик, Feature выключен; нужен scope `admin:org`).
В личном аккаунте типов нет — эпик помечен меткой `epic`.

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/<N> -f type=Баг     # сменить тип
gh issue list --json number,issueType --jq '.[]|select(.issueType.name=="Эпик")'
```

## Priority у существующей задачи (организация)

```bash
# id поля и вариантов
gh api graphql -f query='{organization(login:"<org>"){issueFields(first:10){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}'
# поставить; issueId — node_id issue
gh api graphql -f query='mutation{setIssueFieldValue(input:{issueId:"<node_id>",issueFields:[{fieldId:"<field id>",singleSelectOptionId:"<option id>"}]}){issue{number}}}'
# прочитать: issue.issueFieldValues{nodes{... on IssueFieldSingleSelectValue{field{... on IssueFieldSingleSelect{name}} name}}}
```

## Подзадачи и зависимости у существующей задачи

```bash
SUB_ID=$(gh api repos/{owner}/{repo}/issues/<подзадача> --jq .id)   # id, не номер!
gh api repos/{owner}/{repo}/issues/<эпик>/sub_issues -X POST -F sub_issue_id=$SUB_ID
gh api repos/{owner}/{repo}/issues/<эпик>/sub_issues                # список подзадач
BY_ID=$(gh api repos/{owner}/{repo}/issues/<блокер> --jq .id)       # id, не номер!
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -X POST -F issue_id=$BY_ID
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by      # кто блокирует N
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocking        # кого блокирует N
gh api -X DELETE repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by/$BY_ID
```

## Milestones

```bash
gh api -X GET repos/{owner}/{repo}/milestones -f state=all           # список
gh api repos/{owner}/{repo}/milestones -f title="Биллинг · 1 · Проектирование" -f description="Эпик: #42"
gh issue edit <N> --milestone "Биллинг · 1 · Проектирование"
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```

## Числовые поля проекта

«Оценка, ч», «Факт, ч», «Токены, млн», «Стоимость, $» ставит только скилл
`est`. Руками — лишь «Оценка, ч» эпика, сумма оценок подзадач:

```bash
gh project item-edit --id <item-id> --project-id <project-id> --field-id <id-поля-Оценка> --number 4.5
```

ID проекта, полей и вариантов — `gh project view` / `gh project field-list`
(в JSON `gh project item-list` ключи кириллических полей искажены — не
полагаться на них; `est` ищет поля по точному имени через GraphQL).
