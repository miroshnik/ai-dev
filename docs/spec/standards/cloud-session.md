<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# cloud-session

Скрипты скиллов, которые ходят в GitHub Projects, в облачной сессии выходят с объяснением, а не сбоем `gh`.

Облачной сессии Claude Code Projects v2 недоступны (403): скрипт без проверки падает непонятной ошибкой `gh`, и
агент ищет причину не там. Проверка — переменная `CLAUDE_CODE_REMOTE`, объяснение ведёт в `docs/cloud-sessions.md`.

## Скрипт с Projects v2 проверяет облачную сессию и объясняет, куда смотреть

<details><summary>✅ 1 тест</summary>

- ✅ скрипты скиллов ai-dev, которые ходят в Projects v2, проверяют облачную сессию и ссылаются на docs/cloud-sessions.md

</details>

### примеры

<details><summary>✅ 4 теста</summary>

- ✅ скрипт с Projects v2 без проверки CLAUDE_CODE_REMOTE — нарушение
- ✅ проверка есть, а объяснение не ведёт в docs/cloud-sessions.md — нарушение
- ✅ проверка с объяснением — чисто; `gh project` — тоже Projects v2
- ✅ скрипт без Projects v2 — вне правила

</details>
