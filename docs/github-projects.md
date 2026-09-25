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

Проверка, создание и настройка проекта — скилл `github`: `project check` и
`project fix` (`skills/github/SKILL.md`); там же ограничения API (workflow,
сортировка), шаги UI и команды для задачи в проекте.

## Milestones

```bash
gh api -X GET repos/{owner}/{repo}/milestones -f state=all           # список
gh api repos/{owner}/{repo}/milestones -f title="Биллинг · 1 · Проектирование" -f description="Эпик: #42"
gh issue edit <N> --milestone "Биллинг · 1 · Проектирование"
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```
