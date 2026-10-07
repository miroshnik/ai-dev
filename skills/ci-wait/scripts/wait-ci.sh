#!/usr/bin/env bash
#
# wait-ci.sh — ожидание чеков PR или коммита с видимым прогрессом и полным набором
# исходов. Запускать из каталога репозитория (gh резолвит {owner}/{repo}) или задать
# GH_REPO.
#
#   wait-ci.sh pr <N> [--interval 30] [--timeout 1800] [--expect 0] [--wait-all]
#       Ждёт чеки головы PR (как status), обязательные чеки базовой ветки — по именам, и прогон
#       каждого workflow, который по своему `on:` на SHA головы срабатывает на PR (нужен bun).
#       Конфликт с базой — сразу ERROR: CI на таком PR не запустится.
#
#   wait-ci.sh status <sha> [--context <имя>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
#       Ждёт все чеки коммита: commit statuses (хостинг, внешние сервисы) и
#       check-runs (GitHub Actions). --context — один чек по имени, среди обоих.
#       SHA — полный, из git.
#
#   wait-ci.sh merged <N> [--context <имя>] [--interval 20] [--timeout 1200] [--expect 0] [--wait-all]
#       Ждёт все чеки коммита мержа PR (как status): SHA берёт из PR сам — после мержа
#       его не добывать. PR не влит — ERROR.
#
#   wait-ci.sh issue <N> [--interval 60] [--timeout 7200]
#       Ждёт закрытия issue — бага на красный main (github pr premerge, код 3):
#       PASS, когда закрыт; нет такого issue — ERROR.
#
# Прогон Actions на SHA, упавший без единого job (workflow не разобран, не стартовал), — FAIL с путём файла:
# check-run он не даёт, и без него итог сводился к одним статусам хостинга. Незавершённый прогон без check-runs (в
# очереди) — pending: прогон на SHA есть, а чеков у него ещё нет.
# Пустой список чеков — pending; PASS засчитывается, когда снимок без pending повторился
# два опроса подряд (поздно регистрирующиеся чеки не проскакивают) и чеков не меньше
# --expect. Первый упавший чек — сразу FAIL; --wait-all — FAIL, когда завершились все.
# Только REST: квота GraphQL общая на все сессии; лимит REST — ожидание до сброса. Сбой gh
# (и в запросах до первого опроса) — повтор, ERROR — после пяти подряд; «не найден» — только по 404/422.
#
# Вывод: stdout — только события («CHECK <имя>: <bucket>») и финальная строка
#        «RESULT: PASS|FAIL|TIMEOUT|ERROR …»; stderr — heartbeat каждый опрос.
# Exit:  0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR или неверный вызов.
set -uo pipefail

usage() { awk 'NR > 2 && !/^#/ { exit } NR > 2' "$0" >&2; exit 3; }

mode=${1:-}; target=${2:-}
[ -n "$mode" ] && [ -n "$target" ] || usage
shift 2
interval=""; timeout=""; expect=0; context=""; wait_all=""
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) interval=$2; shift 2 ;;
    --timeout)  timeout=$2;  shift 2 ;;
    --expect)   expect=$2;   shift 2 ;;
    --context)  context=$2;  shift 2 ;;
    --wait-all) wait_all=1;  shift ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done
ts() { date +%H:%M:%S; }
finish() { echo "RESULT: $1"; exit "$2"; }
rate_limited() { grep -qi 'rate limit' <<<"$1"; }

# checks <sha>: чеки коммита в $out — JSON-массив {name, bucket}; bucket как у `gh pr checks`:
# pending | pass | fail | cancel | skipping; пути workflow, давших прогон на SHA, — в $ran. Код 1 — ошибка gh, текст в $out.
# Статусы API уже сводит к последнему на контекст, check-runs — нет: на SHA лежат check-runs всех
# прогонов (отменённый новым push, когда голову вернули на прежний коммит; перезапуск job), и итог —
# за последним check-run имени у того же приложения (id растёт с созданием). Прогон Actions, упавший без job, —
# check-run не даёт: workflow не разобран (имя прогона — путь файла) или не стартовал (в его check suite нет
# check-runs); такой прогон — упавший чек с путём файла и ссылкой. Незавершённый прогон без check-runs (в очереди) —
# pending с путём: прогон на SHA есть, и без этой строки итог сводился к статусам хостинга (#360).
ran='[]'
checks() {
  local statuses runs wruns
  statuses=$(gh api "repos/{owner}/{repo}/commits/$1/status" 2>&1) || { out=$statuses; return 1; }
  runs=$(gh api "repos/{owner}/{repo}/commits/$1/check-runs?per_page=100" 2>&1) || { out=$runs; return 1; }
  wruns=$(gh api "repos/{owner}/{repo}/actions/runs?head_sha=$1&per_page=100" 2>&1) || { out=$wruns; return 1; }
  ran=$(jq -c '[(.workflow_runs // [])[].path] | unique' <<<"$wruns")
  out=$(jq -n --argjson s "$statuses" --argjson r "$runs" --argjson w "$wruns" --arg ctx "$context" '
    [ $s.statuses[] | { name: .context,
        bucket: (if .state == "success" then "pass" elif .state == "pending" then "pending" else "fail" end) } ]
    + [ $r.check_runs | group_by([.name, .app.id]) | map(max_by(.id)) | .[] | { name,
        bucket: (if .status != "completed" then "pending"
                 elif .conclusion == "success" or .conclusion == "neutral" then "pass"
                 elif .conclusion == "skipped" then "skipping"
                 elif .conclusion == "cancelled" then "cancel"
                 else "fail" end) } ]
    + [ [$r.check_runs[].check_suite.id] as $suites
        | ($w.workflow_runs // []) | group_by([.path, .event]) | map(max_by(.id)) | .[]
        | (.check_suite_id as $id | any($suites[]; . == $id) | not) as $nojobs
        | if .status != "completed" then
            select($nojobs) | { name: "workflow \(.status): \(.path) \(.html_url)", bucket: "pending" }
          else
            select((.conclusion == "failure" or .conclusion == "startup_failure") and (.name == .path or $nojobs))
            | { name: "workflow \(if .name == .path then "not parsed" else "failed without jobs" end): \(.path) \(.html_url)",
                bucket: "fail" }
          end ]
    | if $ctx == "" then . else map(select(.name == $ctx)) end' 2>&1)
}

# required: имена обязательных чеков базовой ветки — ruleset и классическая защита. Нет
# правил или прав их читать (приватный репо на Free отвечает 403, ветки нет — 404) — обязательных нет;
# лимит и иной сбой — код 1, как ошибка опроса: разовый сбой не должен стереть обязательные.
required='[]'; required_loaded=""
absent() { [[ "$1" == *"HTTP 403"* || "$1" == *"HTTP 404"* ]] && ! rate_limited "$1"; }
load_required() {
  local rules branch
  rules=$(gh api "repos/{owner}/{repo}/rules/branches/$1" 2>&1) || { absent "$rules" || { out=$rules; return 1; }; rules='[]'; }
  branch=$(gh api "repos/{owner}/{repo}/branches/$1" 2>&1) || { absent "$branch" || { out=$branch; return 1; }; branch='{}'; }
  required=$(jq -nc --argjson r "$rules" --argjson b "$branch" '
    [ ($r | arrays | .[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context),
      ($b | objects | .protection.required_status_checks // {} | select(.enforcement_level != "off") | (.contexts // [])[]) ]
    | unique' 2>/dev/null) || required='[]'
  required_loaded=1
  [ "$required" != '[]' ] && echo "$(ts) required on $1: $(jq -r 'join(", ")' <<<"$required")" >&2
  return 0
}

# expected: пути workflow, которые на событие PR должны дать прогон на голове, — по `on:` их файлов на её SHA (#356).
# Ждём `pull_request` без фильтров или с ветками, пускающими базовую; фильтр путей, `types` без `synchronize`,
# отрицание и иные спецсимволы в ветках без диффа PR не решить — не ждём: ложный TIMEOUT хуже. Файл, который не
# разбирается, — ждём: прогон-«пустышка» даст FAIL, а у PR из форка её нет вовсе. Только активные workflow.
expected='[]'; expected_for=""; workflows=""
pr_expects() {  # stdin — workflow в JSON (null — не разобран); код 0 — ждать его прогона на PR в ветку $1
  jq -e --arg base "$1" '
    def list: if type == "array" then . else [.] end;
    def rx: "^" + (split("**") | map(split("*") | map(gsub("(?<c>[.^$(){}|\\\\])"; "\\\(.c)")) | join("[^/]*")) | join(".*")) + "$";
    def match_base: list | if any(.[]; tostring | test("[?+\\[!]")) then null else any(.[]; tostring | rx as $r | $base | test($r)) end;
    if type != "object" then true
    else .on
      | if type == "string" then (if . == "pull_request" then {} else null end)
        elif type == "array" then (if any(.[]; . == "pull_request") then {} else null end)
        elif type == "object" and has("pull_request") then (.pull_request // {})
        else null end
      | if type != "object" then false
        elif has("paths") or has("paths-ignore") then false
        elif has("types") and (.types | list | any(.[]; . == "synchronize") | not) then false
        elif has("branches") then (.branches | match_base) == true
        elif has("branches-ignore") then (.["branches-ignore"] | match_base) == false
        else true end
    end' >/dev/null
}
load_expected() {  # <sha> <base>
  local list path raw doc exp='[]'
  if [ -z "$workflows" ]; then
    list=$(gh api "repos/{owner}/{repo}/actions/workflows?per_page=100" 2>&1) || { absent "$list" || { out=$list; return 1; }; list='{}'; }
    workflows=$(jq -c '[(.workflows // [])[] | select(.state == "active" and (.path | startswith(".github/workflows/"))) | .path]' <<<"$list")
  fi
  if [ "$workflows" != '[]' ] && ! command -v bun >/dev/null; then
    echo "$(ts) bun not found — workflows due on PR are not checked" >&2; workflows='[]'
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    raw=$(gh api "repos/{owner}/{repo}/contents/$path?ref=$1" 2>&1) || { [[ "$raw" == *"HTTP 404"* ]] && continue; out=$raw; return 1; }
    # не разобран — null; упал сам bun — ошибка опроса, а не «не разобран»: повтор
    doc=$(jq -r '.content // "" | gsub("\n"; "") | @base64d' <<<"$raw" | bun -e '
      const t = await Bun.stdin.text();
      let d = null; try { d = Bun.YAML.parse(t) ?? null } catch {}
      process.stdout.write(JSON.stringify(d))') || { out="bun failed on $path"; return 1; }
    pr_expects "$2" <<<"$doc" && exp=$(jq -c --arg p "$path" '. + [$p]' <<<"$exp")
  done < <(jq -r '.[]' <<<"$workflows")
  expected=$exp; expected_for=$1
  [ "$expected" != '[]' ] && echo "$(ts) workflows due on PR: $(jq -r 'join(", ")' <<<"$expected")" >&2
  return 0
}

# poll: чеки в $out (см. checks). Код 1 — ошибка gh, 2 — ждать бессмысленно (ERROR); текст в $out.
case "$mode" in
  pr)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR PR number expected, got: $target" 3
    : "${interval:=30}" "${timeout:=1800}"
    label="pr#$target"
    poll() {
      local pull base
      pull=$(gh api "repos/{owner}/{repo}/pulls/$target" 2>&1) || {
        out=$pull; [[ "$pull" == *"HTTP 404"* ]] && { out="PR #$target not found: $pull"; return 2; }; return 1; }
      base=$(jq -r .base.ref <<<"$pull")
      # mergeable GitHub вычисляет в фоне: null — ещё не знает, false — конфликт, merge-ref
      # нет, и workflow на pull_request не запустятся вовсе
      if [ "$(jq -r .mergeable <<<"$pull")" == false ]; then
        out="conflict with base $base — CI will not run; rebase onto origin/$base"; return 2
      fi
      [ -n "$required_loaded" ] || load_required "$base" || return 1
      # голова — каждый опрос: новый push меняет SHA, ждать надо чеки текущей
      head_sha=$(jq -r .head.sha <<<"$pull")
      label="pr#$target@${head_sha:0:7}"
      [ "$expected_for" == "$head_sha" ] || load_expected "$head_sha" "$base" || return 1
      checks "$head_sha"
    }
    ;;
  status)
    [[ "$target" =~ ^[0-9a-f]{40}$ ]] || finish "ERROR sha must be full 40-hex (take it from git: git rev-parse origin/main)" 3
    : "${interval:=20}" "${timeout:=1200}"
    label="${context:-commit}@${target:0:7}"; commit_found=""
    poll() {
      local commit
      # по несуществующему SHA API молча отдаёт пустой статус — коммит проверяем до чеков. «Не найден» —
      # только 422 «No commit found» или 404; иной сбой — ошибка опроса: разовый сбой API не исход
      if [ -z "$commit_found" ]; then
        commit=$(gh api "repos/{owner}/{repo}/commits/$target" --jq .sha 2>&1) || {
          out=$commit; [[ "$commit" == *"HTTP 422"* || "$commit" == *"HTTP 404"* ]] && { out="commit $target not found in repository: $commit"; return 2; }; return 1; }
        commit_found=1
      fi
      checks "$target"
    }
    ;;
  merged)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR PR number expected, got: $target" 3
    : "${interval:=20}" "${timeout:=1200}"
    label="merge#$target"; merge_sha=""
    poll() {
      local pull
      if [ -z "$merge_sha" ]; then
        pull=$(gh api "repos/{owner}/{repo}/pulls/$target" 2>&1) || {
          out=$pull; [[ "$pull" == *"HTTP 404"* ]] && { out="PR #$target not found: $pull"; return 2; }; return 1; }
        [ "$(jq -r .merged <<<"$pull")" == true ] || { out="PR #$target not merged (state $(jq -r .state <<<"$pull")) — nothing to wait for"; return 2; }
        # SHA своего мержа — из PR: git rev-parse origin/main при параллельных мержах отдаёт чужой коммит
        merge_sha=$(jq -r .merge_commit_sha <<<"$pull")
        label="${context:-merge#$target}@${merge_sha:0:7}"
      fi
      checks "$merge_sha"
    }
    ;;
  issue)
    [[ "$target" =~ ^[0-9]+$ ]] || finish "ERROR issue number expected, got: $target" 3
    : "${interval:=60}" "${timeout:=7200}"
    label="issue#$target"
    poll() {
      local issue
      issue=$(gh api "repos/{owner}/{repo}/issues/$target" 2>&1) || {
        out=$issue; [[ "$issue" == *"HTTP 404"* ]] && { out="issue #$target not found: $issue"; return 2; }; return 1; }
      # закрыт — исход известен сразу: повторный опрос, как у чеков, нужен поздно регистрирующимся, а не issue
      [ "$(jq -r .state <<<"$issue")" == closed ] && finish "PASS issue #$target closed ($(jq -r '.state_reason // "closed"' <<<"$issue"))" 0
      out=$(jq -nc --arg n "issue #$target" '[{ name: $n, bucket: "pending" }]')
    }
    ;;
  *) usage ;;
esac

# rate_limit_wait: секунды до сброса квоты core; вторичный лимит (квота не исчерпана) — минута
rate_limit_wait() {
  local core w=60
  core=$(gh api rate_limit 2>/dev/null | jq -c .resources.core 2>/dev/null)
  if [ "$(jq -r .remaining <<<"$core" 2>/dev/null)" == 0 ]; then
    w=$(( $(jq -r .reset <<<"$core") - $(date +%s) + 1 ))
  fi
  [ "$w" -lt "$interval" ] && w=$interval
  echo "$w"
}

deadline=$(( $(date +%s) + timeout ))
prev_snapshot=""; prev_terminal=""; errors=0; pending=""; missing=""; unrun=""
while :; do
  nap=$interval
  poll; rc=$?
  if [ "$rc" -eq 0 ]; then
    errors=0
    snapshot=$(printf '%s' "$out" | jq -r 'sort_by(.name) | .[] | "\(.name)\t\(.bucket)"')
    total=$(printf '%s' "$out" | jq 'length')
    pending=$(printf '%s' "$out" | jq '[.[] | select(.bucket=="pending")] | length')
    failed=$(printf '%s' "$out" | jq -r '[.[] | select(.bucket=="fail" or .bucket=="cancel") | .name] | join(", ")')
    missing=$(printf '%s' "$out" | jq -r --argjson req "$required" '$req - map(.name) | join(", ")')
    # workflow, который по `on:` срабатывает на PR, но прогона на голове не дал, — не финал, как обязательный чек
    unrun=$(jq -rn --argjson e "$expected" --argjson r "$ran" '$e - $r | join(", ")')
    if [ "$snapshot" != "$prev_snapshot" ]; then
      comm -13 <(printf '%s\n' "$prev_snapshot") <(printf '%s\n' "$snapshot") \
        | awk -F'\t' 'NF==2 { print "CHECK " $1 ": " $2 }'
      prev_snapshot=$snapshot
    fi
    echo "$(ts) $label total=$total pending=$pending failed=[${failed}]${missing:+ missing=[$missing]}${unrun:+ no-run=[$unrun]}" >&2
    # упавший чек — исход известен: долгие чеки рядом (превью-деплой) его не изменят
    [ -n "$failed" ] && [ -z "$wait_all" ] && finish "FAIL $failed" 1
    if [ "$total" -gt 0 ] && [ "$total" -ge "$expect" ] && [ "$pending" -eq 0 ] && [ -z "$missing" ] && [ -z "$unrun" ]; then
      if [ "$snapshot" == "$prev_terminal" ]; then
        [ -n "$failed" ] && finish "FAIL $failed" 1
        finish "PASS ($total checks)" 0
      fi
      prev_terminal=$snapshot
    else
      prev_terminal=""
    fi
  elif [ "$rc" -eq 2 ]; then
    finish "ERROR $out" 3
  elif rate_limited "$out"; then
    # лимит — не ошибка вызова: чеки идут своим ходом, ждём квоту
    nap=$(rate_limit_wait)
    echo "$(ts) $label: rate limit, next poll in ${nap}s" >&2
  else
    errors=$((errors + 1))
    echo "$(ts) $label: gh error ($errors): ${out:0:200}" >&2
    [ "$errors" -ge 5 ] && finish "ERROR gh: ${out:0:200}" 3
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && finish "TIMEOUT after ${timeout}s (pending=${pending:-?}${missing:+, missing required: $missing}${unrun:+, no run of workflow: $unrun})" 2
  [ "$nap" -gt $((deadline - now)) ] && nap=$((deadline - now))
  sleep "$nap"
done
