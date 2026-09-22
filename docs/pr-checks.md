# Ожидание чеков PR к разделу «Git, PR и мерж»

Правило — в `AGENTS.md`; скилл `ci-wait` делает это скриптом, здесь — механика.

- По номеру PR: цикл опроса `gh pr checks <N> --json name,bucket` раз в
  15–30 с, с таймаутом; решение — только по полю `bucket` (`pending`,
  `fail`, `cancel`, `pass`, `skipping`). Список пуст или есть `pending` →
  ждать. Мерж — когда список непуст, `pending` нет и снимок повторился два
  опроса подряд (чеки регистрируются с опозданием).
- Сразу после push `gh pr checks` отвечает `no checks reported` с exit 1 —
  это «ещё не зарегистрированы», не «упали» и не «прошли». Коды выхода
  0 / 1 (упавшие) / 8 (`pending`) выставляются только **без** `--json`; с
  `--json` exit 0 и при `pending`, и при `fail`.
- По полному SHA коммита (деплой, внешний чек, прогон на `main`):
  `gh api repos/{owner}/{repo}/commits/<sha>/status` (поле `state` и список
  `statuses` по контекстам) или `gh run list --commit <sha>`; `gh pr checks`
  SHA не принимает.
- Без branch protection `gh pr merge --auto` мержит, не дожидаясь CI.
