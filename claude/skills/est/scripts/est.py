#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
est — оценка задач по истории проекта и факт из транскриптов Claude Code.

Подкоманды:
  est history  — таблица закрытых задач с фактом, калибровочный коэффициент k
  est fact     — факт (активные часы в Claude Code) по транскриптам для issue
  est estimate — записать оценку с аналогами и маркером

Только stdlib + CLI `gh`. Источник истины — GitHub (поля проекта «Оценка, ч»,
«Факт, ч» и комментарии с HTML-маркерами <!-- est {...} --> / <!-- fact {...} -->).
Без --write ничего в GitHub не пишется.
"""

import argparse
import glob
import json
import os
import re
import statistics
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
EST_DIR = os.path.join(HOME, ".claude", "est")
REGISTRY_PATH = os.path.join(EST_DIR, "repos.json")
CACHE_DIR = os.path.join(EST_DIR, "cache")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")

FIELD_EST = "Оценка, ч"
FIELD_FACT = "Факт, ч"
FIELD_STATUS = "Status"

# Типы задач = типы conventional commits + research (спайк без кода). Те же слова —
# префиксы веток: <type>/<issue>-<slug> (допускается префикс области: <area>/<type>/<issue>-<slug>).
EST_TYPES = ("feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research")
BRANCH_CONV_RE = re.compile(
    r"^(?:[\w.-]+/)?(?P<type>" + "|".join(EST_TYPES) + r")/(?P<num>\d{1,6})-", re.I)
PR_PAGE = 50
PR_MAX = 500
ISSUES_MAX = 500            # сколько закрытых issue держим в индексе коммитов-закрывателей
SESSION_CACHE_V = 6         # версия формата кэша транскриптов (сменилась — переразбор); 4 = + субагенты, 5 = хеши из любых tool_result, 6 = hint субагента
PROJECT_META_TTL = 86400    # сутки: кэш id проекта/полей перечитываем
OPEN_PRS_TTL = 3600         # час: список открытых PR (их ветки — чужие)
# Долгоживущие ветки: «нейтральные» — сами по себе задачу не привязывают, но внутри окна якоря считаются.
BASE_BRANCHES = {"main", "master", "develop", "dev", "staging", "production", "release"}

# Реестр репозиториев — личный файл ~/.claude/est/repos.json (в репо скилла не входит).
# Формат: {"owner/repo": {"paths": ["/abs/path/to/checkout", ...],
#                         "project": {"owner": "<owner>", "number": <N>}}}
# Без записи репо определяется из git remote origin текущего каталога, проект — по
# привязке к репозиторию; paths нужны, чтобы найти транскрипты (~/.claude/projects).
DEFAULT_REGISTRY = {}

# Файлы, которые не считаем в диффе: lock-файлы, снапшоты, минифицированное, сборка.
DIFF_EXCLUDE = re.compile(
    r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|"
    r"poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|Podfile\.lock)$"
    r"|(^|/)__snapshots__/|\.snap$|\.min\.(js|css)$|(^|/)(dist|build)/|\.generated\.",
    re.I,
)


class EstError(Exception):
    pass


class NotAnIssue(EstError):
    """Номер существует не как issue (обычно это PR)."""


def err_is(e, text):
    return text.lower() in str(e).lower()


def die(msg, code=1):
    print(f"ошибка: {msg}", file=sys.stderr)
    sys.exit(code)


# ----------------------------------------------------------------------------
# Утилиты
# ----------------------------------------------------------------------------

def parse_ts(s):
    """ISO-строка (UTC, с Z) → epoch-секунды. Таймзона учитывается."""
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def fmt_local(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")


def fmt_h(h, digits=2):
    if h is None:
        return "—"
    s = f"{h:.{digits}f}".rstrip("0").rstrip(".")
    return s if s else "0"


def plural(n, one, few, many):
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def parse_since(s):
    m = re.fullmatch(r"(\d+)([dhwm])", s.strip())
    if not m:
        raise EstError(f"неверный период «{s}», ожидается вида 90d / 12w / 6m / 48h")
    n, u = int(m.group(1)), m.group(2)
    secs = {"h": 3600, "d": 86400, "w": 7 * 86400, "m": 30 * 86400}[u]
    return n * secs


def quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


# ----------------------------------------------------------------------------
# gh
# ----------------------------------------------------------------------------

def run(cmd, stdin=None):
    try:
        r = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    except FileNotFoundError:
        raise EstError(f"не найдена команда {cmd[0]!r}; нужен установленный gh CLI")
    if r.returncode != 0:
        raise EstError(f"команда {' '.join(cmd[:3])}… завершилась с кодом {r.returncode}: {r.stderr.strip()[:500]}")
    return r.stdout


def gh_graphql(query, variables):
    body = json.dumps({"query": query, "variables": variables})
    out = run(["gh", "api", "graphql", "--input", "-"], stdin=body)
    data = json.loads(out)
    if data.get("errors"):
        msgs = "; ".join(e.get("message", "") for e in data["errors"])
        if not data.get("data"):
            raise EstError(f"GraphQL: {msgs}")
        print(f"предупреждение GraphQL: {msgs}", file=sys.stderr)
    return data["data"]


def gh_rest(path, method="GET", body=None):
    cmd = ["gh", "api", "-X", method, path]
    stdin = None
    if body is not None:
        cmd += ["--input", "-"]
        stdin = json.dumps(body)
    out = run(cmd, stdin=stdin)
    return json.loads(out) if out.strip() else None


# ----------------------------------------------------------------------------
# Реестр репозиториев и проекты
# ----------------------------------------------------------------------------

def load_registry():
    if not os.path.exists(REGISTRY_PATH):
        save_json(REGISTRY_PATH, DEFAULT_REGISTRY)
        print(f"создан реестр {REGISTRY_PATH}", file=sys.stderr)
    reg = load_json(REGISTRY_PATH, None)
    if not isinstance(reg, dict):
        raise EstError(f"реестр {REGISTRY_PATH} повреждён")
    return reg


def detect_repo():
    try:
        url = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    except FileNotFoundError:
        raise EstError("git не найден; укажите --repo owner/repo")
    if url.returncode != 0:
        raise EstError("не удалось определить репозиторий из git remote origin; укажите --repo owner/repo")
    m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url.stdout.strip())
    if not m:
        raise EstError(f"не разобран remote «{url.stdout.strip()}»; укажите --repo owner/repo")
    return f"{m.group(1)}/{m.group(2)}"


def resolve_repo(arg):
    repo = arg or detect_repo()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise EstError(f"неверный формат --repo «{repo}», ожидается owner/repo")
    return repo


class Repo:
    """Репозиторий + его проект GitHub + кэши."""

    def __init__(self, full, registry):
        self.full = full
        self.owner, self.name = full.split("/")
        cfg = registry.get(full) or {}
        self.paths = cfg.get("paths") or []
        self.project_ref = cfg.get("project")
        self.cache_dir = os.path.join(CACHE_DIR, full.replace("/", "__"))
        self._meta = None
        self._prs = None
        self._open = None
        self._closers = None
        self._sessions = None
        self._rows = None
        self.default_branch = None

    # --- проект -----------------------------------------------------------
    def project_meta(self, force=False):
        """id проекта, id полей и вариантов Status. Кэшируется на диске (сутки, с проверкой реестра)."""
        if self._meta and not force:
            return self._meta
        path = os.path.join(self.cache_dir, "project.json")
        meta = None if force else load_json(path, None)
        if meta and meta.get("fields", {}).get(FIELD_FACT):
            fresh = (datetime.now(timezone.utc).timestamp() - (meta.get("fetched_at") or 0)) < PROJECT_META_TTL
            same = (not self.project_ref or (meta.get("owner") == self.project_ref.get("owner")
                                             and meta.get("number") == int(self.project_ref.get("number"))))
            if fresh and same:
                self._meta = meta
                return meta
        owner, number = self._find_project()
        q = """
        query($o:String!,$n:Int!){
          organization(login:$o){ projectV2(number:$n){ ...F } }
        }
        fragment F on ProjectV2 { id title number
          fields(first:50){ nodes{ __typename
            ... on ProjectV2Field{ id name dataType }
            ... on ProjectV2SingleSelectField{ id name dataType options{ id name } } } } }
        """
        try:
            data = gh_graphql(q, {"o": owner, "n": number})
            pv = data["organization"]["projectV2"]
        except EstError:
            pv = None
        if not pv:
            data = gh_graphql(q.replace("organization(login:$o)", "user(login:$o)"), {"o": owner, "n": number})
            pv = (data.get("user") or {}).get("projectV2")
        if not pv:
            raise EstError(f"проект {owner} #{number} не найден")
        fields = {}
        for f in pv["fields"]["nodes"]:
            if f.get("name") in (FIELD_EST, FIELD_FACT, FIELD_STATUS):
                fields[f["name"]] = {"id": f["id"], "options": {o["name"]: o["id"] for o in f.get("options", [])}}
        missing = [n for n in (FIELD_EST, FIELD_FACT, FIELD_STATUS) if n not in fields]
        if missing:
            raise EstError(f"в проекте {owner} #{number} нет полей: {', '.join(missing)}")
        meta = {"id": pv["id"], "owner": owner, "number": number, "title": pv["title"], "fields": fields,
                "fetched_at": datetime.now(timezone.utc).timestamp()}
        save_json(path, meta)
        self._meta = meta
        return meta

    def project_rows(self):
        """Элементы проекта, один раз за запуск."""
        if self._rows is None:
            self._rows = self.project_items()
        return self._rows

    def _find_project(self):
        if self.project_ref:
            return self.project_ref["owner"], int(self.project_ref["number"])
        q = """query($o:String!,$r:String!){ repository(owner:$o,name:$r){
            projectsV2(first:5){ nodes{ number title owner{ ... on Organization{login} ... on User{login} } } } } }"""
        data = gh_graphql(q, {"o": self.owner, "r": self.name})
        nodes = data["repository"]["projectsV2"]["nodes"]
        if not nodes:
            raise EstError(f"у репозитория {self.full} нет привязанного проекта и нет записи в {REGISTRY_PATH}")
        n = nodes[0]
        return n["owner"]["login"], n["number"]

    def project_items(self):
        """Все элементы проекта с полями и последними комментариями issue."""
        meta = self.project_meta()
        q = """
        query($id:ID!,$c:String){ node(id:$id){ ... on ProjectV2{
          items(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id type
            content{ __typename ... on Issue{ id number title state stateReason closedAt createdAt
              labels(first:15){nodes{name}} comments(last:25){nodes{databaseId body}} } }
            fieldValues(first:20){ nodes{ __typename
              ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{name} } }
              ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2SingleSelectField{name} } } } } } } } } }
        """
        rows = []
        cursor = None
        while True:
            data = gh_graphql(q, {"id": meta["id"], "c": cursor})
            items = data["node"]["items"]
            for it in items["nodes"]:
                c = it.get("content") or {}
                if c.get("__typename") != "Issue":
                    continue
                row = {
                    "item_id": it["id"], "issue_id": c["id"], "number": c["number"], "title": c["title"],
                    "state": c["state"], "stateReason": c.get("stateReason"),
                    "closedAt": parse_ts(c.get("closedAt")), "createdAt": parse_ts(c.get("createdAt")),
                    "labels": [l["name"] for l in c["labels"]["nodes"]],
                    "est": None, "fact": None, "status": None,
                    "est_marker": None, "fact_marker": None,
                }
                for fv in it["fieldValues"]["nodes"]:
                    fname = (fv.get("field") or {}).get("name")
                    if fname == FIELD_EST:
                        row["est"] = fv.get("number")
                    elif fname == FIELD_FACT:
                        row["fact"] = fv.get("number")
                    elif fname == FIELD_STATUS:
                        row["status"] = fv.get("name")
                for cm in c["comments"]["nodes"]:
                    em = parse_marker(cm["body"], "est")
                    fm = parse_marker(cm["body"], "fact")
                    if em:
                        row["est_marker"] = em
                    if fm:
                        row["fact_marker"] = fm
                rows.append(row)
            if not items["pageInfo"]["hasNextPage"]:
                break
            cursor = items["pageInfo"]["endCursor"]
        return rows

    # --- PR ---------------------------------------------------------------
    PR_FIELDS = """number title state headRefName baseRefName body mergedAt updatedAt additions deletions changedFiles
        mergeCommit{oid} closingIssuesReferences(first:20){nodes{number}}
        commits(first:100){totalCount nodes{commit{oid authoredDate}}}
        files(first:100){nodes{path additions deletions}}"""

    @staticmethod
    def _pack_pr(p):
        return {
            "number": p["number"], "title": p.get("title"), "state": p.get("state"),
            "headRefName": p.get("headRefName") or "", "baseRefName": p.get("baseRefName") or "",
            "body": p.get("body") or "",
            "mergedAt": parse_ts(p.get("mergedAt")), "updatedAt": parse_ts(p.get("updatedAt")),
            "additions": p.get("additions") or 0, "deletions": p.get("deletions") or 0,
            "changedFiles": p.get("changedFiles") or 0,
            "mergeCommit": (p.get("mergeCommit") or {}).get("oid"),
            "closing": [n["number"] for n in (p.get("closingIssuesReferences") or {}).get("nodes", [])],
            "commits": [{"oid": c["commit"]["oid"], "at": parse_ts(c["commit"]["authoredDate"])}
                        for c in (p.get("commits") or {}).get("nodes", [])],
            "commits_total": (p.get("commits") or {}).get("totalCount", 0),
            "files": [{"path": f["path"], "a": f["additions"], "d": f["deletions"]}
                      for f in (p.get("files") or {}).get("nodes", [])],
        }

    def prs(self):
        """Кэш смёрженных PR (инкрементально по updatedAt)."""
        if self._prs is not None:
            return self._prs
        path = os.path.join(self.cache_dir, "prs.json")
        cache = load_json(path, {"prs": {}})
        prs = {int(k): v for k, v in cache.get("prs", {}).items()}
        if any("baseRefName" not in v for v in prs.values()):
            prs = {}  # старый формат кэша — перечитать
        self.default_branch = cache.get("default_branch")
        known_max = max((v.get("updatedAt") or 0) for v in prs.values()) if prs else 0
        q = ("query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){ defaultBranchRef{name} "
             "pullRequests(first:%d,after:$c,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){ "
             "pageInfo{hasNextPage endCursor} nodes{ %s } } } }" % (PR_PAGE, self.PR_FIELDS))
        cursor = None
        fetched = 0
        stop = False
        while not stop and fetched < PR_MAX:
            data = gh_graphql(q, {"o": self.owner, "r": self.name, "c": cursor})
            self.default_branch = ((data["repository"].get("defaultBranchRef") or {}).get("name")) or self.default_branch
            conn = data["repository"]["pullRequests"]
            for p in conn["nodes"]:
                packed = self._pack_pr(p)
                fetched += 1
                if prs and (packed["updatedAt"] or 0) <= known_max and packed["number"] in prs:
                    stop = True
                    break
                prs[packed["number"]] = packed
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = conn["pageInfo"]["endCursor"]
        self._prs = prs
        self._save_prs(cache)
        return prs

    def _save_prs(self, cache=None):
        path = os.path.join(self.cache_dir, "prs.json")
        cache = dict(cache if cache is not None else load_json(path, {}))
        cache["prs"] = {str(k): v for k, v in self._prs.items()}
        cache["default_branch"] = self.default_branch
        if self._open is not None:
            cache["open"] = self._open
        save_json(path, cache)

    def pr(self, number):
        """Один PR (в т.ч. не смёрженный) — из кэша или запросом. None — только если такого PR нет."""
        prs = self.prs()
        if number in prs:
            return prs[number]
        q = "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ %s } } }" % self.PR_FIELDS
        try:
            data = gh_graphql(q, {"o": self.owner, "r": self.name, "n": number})
        except EstError as e:
            if err_is(e, "Could not resolve to a PullRequest"):
                return None
            raise
        p = data["repository"]["pullRequest"]
        if not p:
            return None
        packed = self._pack_pr(p)
        if packed["state"] == "MERGED":
            prs[number] = packed
            self._save_prs()
        return packed

    def open_prs(self):
        """Открытые PR: {номер: {headRefName, closing}} — их ветки чужие для остальных задач (кэш на час)."""
        if self._open is not None:
            return self._open
        self.prs()
        cache = load_json(os.path.join(self.cache_dir, "prs.json"), {})
        now = datetime.now(timezone.utc).timestamp()
        cached = cache.get("open")
        if cached and now - (cached.get("at") or 0) < OPEN_PRS_TTL:
            self._open = cached
            return cached
        q = """query($o:String!,$r:String!){ repository(owner:$o,name:$r){ pullRequests(states:[OPEN],first:100){
            nodes{ number headRefName closingIssuesReferences(first:20){nodes{number}} } } } }"""
        data = gh_graphql(q, {"o": self.owner, "r": self.name})
        items = {}
        for p in data["repository"]["pullRequests"]["nodes"]:
            items[str(p["number"])] = {"headRefName": p.get("headRefName") or "",
                                       "closing": [n["number"] for n in p["closingIssuesReferences"]["nodes"]]}
        self._open = {"at": now, "items": items}
        self._save_prs(cache)
        return self._open

    def neutral_branches(self):
        self.prs()
        return BASE_BRANCHES | ({self.default_branch} if self.default_branch else set())

    def closers(self):
        """Индекс закрывателей всех закрытых issue репо (инкрементально по updatedAt):
        {"oid": {oid: {"issues": [...], "at": ts}}, "pr": {"N": [issues]}}."""
        if self._closers is not None:
            return self._closers
        path = os.path.join(self.cache_dir, "closers.json")
        cache = load_json(path, {"issues": {}})
        issues = dict(cache.get("issues") or {})
        known_max = max((v.get("updatedAt") or 0) for v in issues.values()) if issues else 0
        q = """query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){
          issues(states:[CLOSED],first:100,after:$c,orderBy:{field:UPDATED_AT,direction:DESC}){
            pageInfo{hasNextPage endCursor} nodes{ number updatedAt
              timelineItems(last:3,itemTypes:[CLOSED_EVENT]){ nodes{ ... on ClosedEvent{ closer{ __typename
                ... on Commit{ oid authoredDate } ... on PullRequest{ number repository{nameWithOwner} } } } } } } } } }"""
        cursor, fetched, stop = None, 0, False
        while not stop and fetched < ISSUES_MAX:
            data = gh_graphql(q, {"o": self.owner, "r": self.name, "c": cursor})
            conn = data["repository"]["issues"]
            for n in conn["nodes"]:
                fetched += 1
                upd = parse_ts(n.get("updatedAt")) or 0
                key = str(n["number"])
                if issues and upd <= known_max and key in issues:
                    stop = True
                    break
                closers = []
                for t in n["timelineItems"]["nodes"]:
                    c = (t or {}).get("closer") or {}
                    if c.get("__typename") == "Commit":
                        closers.append({"type": "commit", "oid": c["oid"], "at": parse_ts(c.get("authoredDate"))})
                    elif c.get("__typename") == "PullRequest" and (c.get("repository") or {}).get("nameWithOwner", self.full) == self.full:
                        closers.append({"type": "pr", "number": c["number"]})
                issues[key] = {"updatedAt": upd, "closers": closers}
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = conn["pageInfo"]["endCursor"]
        save_json(path, {"issues": issues})
        oid, pr = {}, {}
        for key, v in issues.items():
            num = int(key)
            for c in v["closers"]:
                if c["type"] == "commit":
                    d = oid.setdefault(c["oid"], {"issues": [], "at": c.get("at")})
                    if num not in d["issues"]:
                        d["issues"].append(num)
                else:
                    lst = pr.setdefault(str(c["number"]), [])
                    if num not in lst:
                        lst.append(num)
        self._closers = {"oid": oid, "pr": pr}
        return self._closers

    def commit_diff(self, oid):
        """Дифф одиночного коммита (для issue без PR): строки без lock/снапшотов/минифицированного. Кэш."""
        path = os.path.join(self.cache_dir, "commits.json")
        cache = load_json(path, {})
        if oid in cache:
            return cache[oid]
        try:
            data = gh_rest(f"repos/{self.full}/commits/{oid}")
        except EstError as e:
            print(f"предупреждение: дифф коммита {oid[:7]} не получен: {e}", file=sys.stderr)
            return None
        files = data.get("files") or []
        n = sum((f.get("additions") or 0) + (f.get("deletions") or 0) for f in files if not DIFF_EXCLUDE.search(f.get("filename") or ""))
        cache[oid] = n
        save_json(path, cache)
        return n

    # --- транскрипты -------------------------------------------------------
    def sessions(self):
        if self._sessions is None:
            self._sessions = load_sessions(self)
        return self._sessions


# ----------------------------------------------------------------------------
# Маркеры в комментариях
# ----------------------------------------------------------------------------

def parse_marker(body, kind):
    if not body:
        return None
    m = re.search(r"<!--\s*%s\s+(\{.*?\})\s*-->" % kind, body, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


# ----------------------------------------------------------------------------
# Транскрипты Claude Code
# ----------------------------------------------------------------------------

def encode_path(path):
    return re.sub(r"[^A-Za-z0-9]", "-", path)


HASH_RE = re.compile(r"(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])")
ISSUE_REF_RE = re.compile(r"(?<![\w/])#(\d{1,6})\b")                                  # «#N»
ISSUE_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/issues/(\d{1,6})(?!\d)")     # URL issue c репо
# Не человеческие промпты: уведомления, служебные вставки, автоматические рутины (scheduled-task).
SKIP_PROMPT_PREFIXES = ("<task-notification", "<\\task-notification", "<local-command", "<command-",
                        "<system-reminder", "<\\system-reminder", "<bash-", "<scheduled-task", "<\\scheduled-task")


def _text_of_content(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text") or "")
                elif isinstance(b.get("content"), (str, list)):
                    parts.append(_text_of_content(b["content"]))
            elif isinstance(b, str):
                parts.append(b)
        return "\n".join(parts)
    return ""


def _is_human_prompt(r):
    if r.get("type") != "user" or r.get("isSidechain") or r.get("isMeta"):
        return False
    origin = r.get("origin")
    if isinstance(origin, dict) and origin.get("kind") and origin["kind"] != "human":
        return False
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return False
    txt = _text_of_content(c).lstrip()
    if not txt:
        return False
    return not txt.startswith(SKIP_PROMPT_PREFIXES)


def _scan_jsonl(path, acc, subagent):
    """Разобрать один jsonl (сессия или её субагент) в общий аккумулятор acc.

    Субагенты (<sid>/subagents/**/*.jsonl — Agent/Workflow) — часть той же сессии:
    их записи идут в таймлайн и дают якоря по коммитам, но «человеческие» промпты
    в них — это задания от оркестратора, а не от человека, поэтому n_human и
    первый промпт берём только с верхнего уровня. Зато задание субагенту часто
    называет задачу («#N» или URL issue): если в нём ровно один номер, все записи
    этого субагента получают подсказку hint=N — так работа параллельных
    субагентов в workflow привязывается к своим задачам, а не делится по порядку
    коммитов.
    """
    commit_tool_ids = {}
    hint = ""            # подсказка задачи для записей субагента: "N" или "owner/repo#N"
    hint_done = not subagent
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            t = r.get("type")
            ts = parse_ts(r.get("timestamp")) if r.get("timestamp") else None
            if acc["cwd"] is None and r.get("cwd"):
                acc["cwd"] = r["cwd"]
            if t == "pr-link":
                pr = r.get("prNumber")
                if ts and isinstance(pr, int):
                    acc["prlinks"].append([ts, pr])
                continue
            if t not in ("user", "assistant"):
                continue
            if ts is None:
                continue
            human = (not subagent) and _is_human_prompt(r)
            if human:
                acc["n_human"] += 1
            msg = r.get("message") or {}
            content = msg.get("content")
            if not hint_done and t == "user":
                # первый промпт субагента — задание от оркестратора
                txt = _text_of_content(content)
                if txt.strip():
                    hint_done = True
                    nums = sorted({int(x) for x in ISSUE_REF_RE.findall(txt)})
                    urls = sorted({f"{o}#{int(x)}" for o, x in ISSUE_URL_RE.findall(txt)})
                    if len(urls) == 1 and (not nums or nums == [int(urls[0].split("#")[1])]):
                        hint = urls[0]
                    elif len(nums) == 1 and not urls:
                        hint = str(nums[0])
            acc["ev"].append([ts, r.get("gitBranch") or "", 1 if human else 0, hint])
            if human and acc["first_refs"] is None:
                txt = _text_of_content(content)
                acc["first_refs"] = sorted({int(x) for x in ISSUE_REF_RE.findall(txt)})
                acc["first_urls"] = sorted({f"{o}#{int(x)}" for o, x in ISSUE_URL_RE.findall(txt)})
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if t == "assistant" and b.get("type") == "tool_use":
                    inp = b.get("input")
                    cmd = inp.get("command") if isinstance(inp, dict) else None
                    if isinstance(cmd, str) and "git commit" in cmd:
                        commit_tool_ids[b.get("id")] = True
                elif t == "user" and b.get("type") == "tool_result":
                    # Хеши берём из ЛЮБОГО tool_result, не только после `git commit`: коммит
                    # часто делает скрипт (проверки + commit + push), и хеш всплывает в его
                    # выводе. Ложные якоря (старые хеши из git log) отсекает ANCHOR_TOLERANCE —
                    # хеш должен появиться рядом по времени с authoredDate коммита.
                    txt = _text_of_content(b.get("content"))
                    tur = r.get("toolUseResult")
                    if isinstance(tur, dict):
                        txt += "\n" + str(tur.get("stdout") or "") + "\n" + str(tur.get("stderr") or "")
                    if b.get("tool_use_id") not in commit_tool_ids and "git" not in txt and len(txt) > 20000:
                        continue  # огромный вывод без git — не тратим время
                    seen = set()
                    for h in HASH_RE.findall(txt):
                        if h not in seen and len(seen) < 60 and len(acc["commits"]) < 5000:
                            seen.add(h)
                            acc["commits"].append([ts, h])


def subagent_files(path):
    """Транскрипты субагентов сессии: <dir>/<sid>/subagents/**/*.jsonl."""
    sdir = os.path.join(path[:-6], "subagents")
    if not os.path.isdir(sdir):
        return []
    return sorted(glob.glob(os.path.join(sdir, "**", "*.jsonl"), recursive=True))


def parse_session_file(path):
    """Компактная сводка одной сессии: jsonl верхнего уровня + её субагенты."""
    acc = {
        "cwd": None, "n_human": 0, "ev": [], "prlinks": [], "commits": [],
        "first_refs": None, "first_urls": [],
    }
    _scan_jsonl(path, acc, subagent=False)
    subs = subagent_files(path)
    for sf in subs:
        try:
            _scan_jsonl(sf, acc, subagent=True)
        except OSError:
            continue
    acc["ev"].sort(key=lambda e: e[0])
    acc["prlinks"].sort(key=lambda e: e[0])
    acc["commits"].sort(key=lambda e: e[0])
    sid = os.path.basename(path)[:-6]
    return {
        "sid": sid, "cwd": acc["cwd"], "n_human": acc["n_human"], "ev": acc["ev"],
        "prlinks": acc["prlinks"], "commits": acc["commits"],
        "first_refs": acc["first_refs"] or [], "first_urls": acc["first_urls"],
        "n_subagents": len(subs),
        "routine": acc["n_human"] < 3 and not acc["prlinks"] and not acc["commits"],
    }


def session_mtime(path):
    """mtime сессии с учётом субагентов (их файлы дописываются позже верхнего уровня)."""
    m = os.path.getmtime(path)
    for sf in subagent_files(path):
        try:
            m = max(m, os.path.getmtime(sf))
        except OSError:
            pass
    return m


def transcript_files(repo):
    files = []
    for p in repo.paths:
        enc = encode_path(p)
        try:
            dirs = [d for d in os.listdir(PROJECTS_DIR) if d.startswith(enc)]
        except OSError:
            continue
        for d in dirs:
            for f in glob.glob(os.path.join(PROJECTS_DIR, d, "*.jsonl")):
                files.append(f)
    return sorted(set(files))


def _cwd_matches(cwd, paths):
    if not cwd:
        return True  # не знаем — не отбрасываем
    for p in paths:
        if cwd == p or cwd.startswith(p.rstrip("/") + "/"):
            return True
    return False


def load_sessions(repo):
    """Разбор транскриптов с кэшем по mtime (инкрементально)."""
    if not repo.paths:
        raise EstError(f"для {repo.full} не заданы локальные пути в {REGISTRY_PATH} — транскрипты искать негде")
    path = os.path.join(repo.cache_dir, "sessions.json")
    cache = load_json(path, {})
    out = {}
    changed = False
    files = transcript_files(repo)
    for f in files:
        try:
            mtime = session_mtime(f)
        except OSError:
            continue
        c = cache.get(f)
        if c and c.get("mtime") == mtime and c.get("v") == SESSION_CACHE_V:
            out[f] = c
            continue
        s = parse_session_file(f)
        s["mtime"] = mtime
        s["v"] = SESSION_CACHE_V
        out[f] = s
        changed = True
    if changed or set(cache) != set(out):
        save_json(path, out)
    sessions = []
    for f, s in out.items():
        if not s["ev"] or s.get("routine"):
            continue
        if not _cwd_matches(s.get("cwd"), repo.paths):
            continue
        sessions.append(s)
    return sessions


# ----------------------------------------------------------------------------
# Привязка задачи к PR/коммитам
# ----------------------------------------------------------------------------

def branch_tokens(branch):
    return [t for t in re.split(r"[/_\-.]+", branch or "") if t]


def branch_has_issue(branch, n):
    """Ветка содержит номер задачи как отдельный токен (issue-N-…, /N-…, -N-…),
    соседние токены не чисто числовые (чтобы даты вида 2026-09-16 не ловились)."""
    toks = branch_tokens(branch)
    sn = str(n)
    for i, t in enumerate(toks):
        prev = toks[i - 1] if i > 0 else ""
        nxt = toks[i + 1] if i + 1 < len(toks) else ""
        if t.lower() in (f"issue{sn}", f"issues{sn}", f"gh{sn}"):
            return True
        if t == sn:
            if prev.isdigit() or nxt.isdigit():
                continue
            if n < 10 and prev.lower() not in ("issue", "issues", "gh"):
                continue  # однозначные номера — только с явным issue-N
            return True
    return False


def branch_issue_number(branch):
    """Номер задачи из ветки: <type>/N-slug (конвенция) или issue-N / issues/N.
    Голые числа в других местах (release/2026-09) номером не считаются."""
    m = BRANCH_CONV_RE.match(branch or "")
    if m:
        return int(m.group("num"))
    m = re.search(r"(?:^|[/_-])issues?[/_-]?(\d{1,6})(?:$|[/_-])", branch or "", re.I)
    return int(m.group(1)) if m else None


def branch_type(branch):
    """Тип задачи из ветки <type>/N-slug, если ветка по конвенции."""
    m = BRANCH_CONV_RE.match(branch or "")
    return m.group("type").lower() if m else None


def closing_re(repo, n):
    return re.compile(
        r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|закрывает|закрыт[аоы]?|закрыть|исправляет|решает|устраняет)"
        r"[\s:]*(?:#|https://github\.com/%s/%s/issues/)%d(?!\d)" % (re.escape(repo.owner), re.escape(repo.name), n),
        re.I,
    )


def fetch_issue(repo, number):
    q = """
    query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){
      id number title state stateReason closedAt createdAt url
      issueType{name}
      labels(first:20){nodes{name}}
      closedByPullRequestsReferences(first:20){nodes{number repository{nameWithOwner}}}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){ nodes{ __typename
        ... on CrossReferencedEvent{ source{ __typename ... on PullRequest{ number repository{nameWithOwner} } } }
        ... on ConnectedEvent{ subject{ __typename ... on PullRequest{ number repository{nameWithOwner} } } } } }
      closedEvents: timelineItems(last:10,itemTypes:[CLOSED_EVENT]){ nodes{ __typename
        ... on ClosedEvent{ closer{ __typename ... on PullRequest{ number repository{nameWithOwner} } ... on Commit{ oid authoredDate } } } } }
      projectItems(first:10){ nodes{ id project{ id } fieldValues(first:20){ nodes{ __typename
        ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{name} } }
        ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2SingleSelectField{name} } } } } } }
      comments(last:100){ nodes{ databaseId body author{login} } }
    } } }"""
    try:
        data = gh_graphql(q, {"o": repo.owner, "r": repo.name, "n": number})
    except EstError as e:
        if err_is(e, "Could not resolve to an Issue"):
            raise NotAnIssue(f"#{number} — не issue в {repo.full}")
        raise
    issue = data["repository"]["issue"]
    if not issue:
        raise EstError(f"issue #{number} не найден в {repo.full}")
    # события закрытия — в общий список timeline (маркеры fact/est ищем в последних 100 комментариях)
    issue["timelineItems"]["nodes"] += issue.get("closedEvents", {}).get("nodes", [])
    return issue


def issue_project_fields(issue, meta):
    """Значения полей проекта для issue (item_id, est, fact, status)."""
    for it in issue.get("projectItems", {}).get("nodes", []):
        if it["project"]["id"] != meta["id"]:
            continue
        vals = {"item_id": it["id"], "est": None, "fact": None, "status": None}
        for fv in it["fieldValues"]["nodes"]:
            fname = (fv.get("field") or {}).get("name")
            if fname == FIELD_EST:
                vals["est"] = fv.get("number")
            elif fname == FIELD_FACT:
                vals["fact"] = fv.get("number")
            elif fname == FIELD_STATUS:
                vals["status"] = fv.get("name")
        return vals
    return {"item_id": None, "est": None, "fact": None, "status": None}


def resolve_links(repo, issue):
    """Issue → PR (сильные и слабые связи) и коммиты-закрыватели."""
    n = issue["number"]
    same = lambda o: (o or {}).get("repository", {}).get("nameWithOwner", repo.full) == repo.full
    strong, weak = {}, {}
    closers = []

    def add(d, num, why):
        if num and num != n:
            d.setdefault(num, why)

    for p in issue["closedByPullRequestsReferences"]["nodes"]:
        if same(p):
            add(strong, p["number"], "закрыл issue")
    for t in issue["timelineItems"]["nodes"]:
        tn = t["__typename"]
        if tn == "CrossReferencedEvent":
            s = t.get("source") or {}
            if s.get("__typename") == "PullRequest" and same(s):
                add(weak, s["number"], "упоминание")
        elif tn == "ConnectedEvent":
            s = t.get("subject") or {}
            if s.get("__typename") == "PullRequest" and same(s):
                add(strong, s["number"], "связан вручную")
        elif tn == "ClosedEvent":
            c = t.get("closer") or {}
            if c.get("__typename") == "PullRequest" and same(c):
                add(strong, c["number"], "закрыл issue")
            elif c.get("__typename") == "Commit":
                closers.append({"oid": c["oid"], "at": parse_ts(c.get("authoredDate"))})

    prs = repo.prs()
    crx = closing_re(repo, n)
    mention = re.compile(r"(?<![\w/])#%d(?!\d)" % n)
    closer_oids = {c["oid"] for c in closers}
    for num, p in prs.items():
        if n in p["closing"]:
            add(strong, num, "closingIssuesReferences")
        elif p["mergeCommit"] and p["mergeCommit"] in closer_oids:
            add(strong, num, "merge-коммит закрыл issue")
        elif any(c["oid"] in closer_oids for c in p["commits"]):
            add(strong, num, "коммит PR закрыл issue")
        elif crx.search(p["body"]):
            add(strong, num, "Closes #%d в теле PR" % n)
        elif branch_has_issue(p["headRefName"], n):
            add(strong, num, "номер в ветке")
        elif mention.search(p["body"]):
            add(weak, num, "упоминание в теле PR")
    for num in list(strong):
        weak.pop(num, None)
    # Слабые связи используем только если сильных нет
    use, weak_used = (strong, False) if strong else (weak, bool(weak))
    pr_objs = []
    for num, why in sorted(use.items()):
        p = repo.pr(num)
        if p:
            p = dict(p)
            p["why"] = why
            pr_objs.append(p)
    # коммиты-закрыватели, не принадлежащие ни одному найденному PR
    pr_oids = {c["oid"] for p in pr_objs for c in p["commits"]} | {p["mergeCommit"] for p in pr_objs if p["mergeCommit"]}
    closers = [c for c in closers if c["oid"] not in pr_oids]
    return pr_objs, closers, weak_used


# ----------------------------------------------------------------------------
# Расчёт факта по транскриптам
# ----------------------------------------------------------------------------

def diff_size(pr):
    if pr["files"] and len(pr["files"]) >= min(pr["changedFiles"], 100):
        return sum(f["a"] + f["d"] for f in pr["files"] if not DIFF_EXCLUDE.search(f["path"]))
    return pr["additions"] + pr["deletions"]


ANCHOR_TOLERANCE = 30 * 60  # хеш в выводе инструмента должен быть рядом по времени с authoredDate коммита


def oid_index(prs):
    """Индекс: первые 7 символов oid → [(oid, pr_number, authoredDate)] для проверки префиксов."""
    idx = {}
    for num, p in prs.items():
        for c in p["commits"]:
            idx.setdefault(c["oid"][:7], []).append((c["oid"], num, c.get("at")))
    return idx


def near(ts, at):
    return at is None or abs(ts - at) <= ANCHOR_TOLERANCE


def hash_matches(h, oids):
    """Короткий хеш h является префиксом одного из oids (или наоборот)."""
    for o in oids:
        if o.startswith(h) or h.startswith(o):
            return True
    return False


def compute_fact(repo, number, pr_objs, closers, gap_min=30):
    prs_all = repo.prs()
    open_prs = repo.open_prs()["items"]
    cidx = repo.closers()
    sessions = repo.sessions()
    neutral = repo.neutral_branches()
    gap = gap_min * 60.0

    our_prs = {p["number"] for p in pr_objs}

    # --- «единицы» задачи (PR, коммит-закрыватель) и их доля: один PR/коммит на k задач → 1/k ----------
    def issues_of_pr(num):
        s = set((prs_all.get(num) or {}).get("closing") or []) | set(cidx["pr"].get(str(num)) or [])
        s.add(number)
        return s

    def issues_of_oid(oid):
        s = set((cidx["oid"].get(oid) or {}).get("issues") or [])
        s.add(number)
        return s

    shared = []
    pr_w = {}
    for p in pr_objs:
        iss = issues_of_pr(p["number"])
        pr_w[p["number"]] = 1.0 / len(iss)
        if len(iss) > 1:
            shared.append({"unit": f"PR #{p['number']}", "with": sorted(iss - {number}), "k": len(iss)})
    our_branches = {}  # ветка → доля
    for p in pr_objs:
        if p["headRefName"]:
            our_branches[p["headRefName"]] = max(our_branches.get(p["headRefName"], 0), pr_w[p["number"]])
    for num, p in open_prs.items():
        if number in p["closing"] and p["headRefName"]:
            our_branches.setdefault(p["headRefName"], 1.0)
    our_oid = {}  # oid → (authoredDate, доля)
    for p in pr_objs:
        for c in p["commits"]:
            our_oid[c["oid"]] = (c.get("at"), pr_w[p["number"]])
    for c in closers:
        iss = issues_of_oid(c["oid"])
        our_oid[c["oid"]] = (c.get("at"), 1.0 / len(iss))
        if len(iss) > 1:
            shared.append({"unit": f"коммит {c['oid'][:7]}", "with": sorted(iss - {number}), "k": len(iss)})

    idx = oid_index(prs_all)  # коммиты смёрженных PR (чужие якоря)
    foreign_closers = {}      # коммиты-закрыватели других issue (чужие якоря): префикс → [(oid, at)]
    for oid, info in cidx["oid"].items():
        if number not in (info.get("issues") or []) and oid not in our_oid:
            foreign_closers.setdefault(oid[:7], []).append((oid, info.get("at")))
    branch2prs = {}
    for num, p in prs_all.items():
        if p["headRefName"]:
            branch2prs.setdefault(p["headRefName"], set()).add(num)
    for num, p in open_prs.items():
        if p["headRefName"] and number not in p["closing"]:
            branch2prs.setdefault(p["headRefName"], set()).add(-int(num))  # открытый PR: точно не наш

    def is_neutral(b):
        return b in ("", "HEAD") or b in neutral

    def is_our_branch(b):
        return bool(b) and not is_neutral(b) and (b in our_branches or branch_has_issue(b, number))

    def branch_w(b):
        return our_branches.get(b, 1.0)

    def is_foreign_branch(b):
        if not b or is_neutral(b) or is_our_branch(b):
            return False
        nums = branch2prs.get(b)
        if nums and not (nums & our_prs):
            return True
        bi = branch_issue_number(b)
        return bi is not None and bi != number

    def hash_class(h, ts):
        """(свой/чужой/нейтральный, доля); хеш — якорь только рядом по времени с датой коммита
        (в выводе git commit бывают и чужие хеши — из git log, rebase и т.п.)."""
        for oid, (at, w) in our_oid.items():
            if (oid.startswith(h) or h.startswith(oid)) and near(ts, at):
                return "own", w
        for oid, num, at in idx.get(h[:7], []):
            if (oid.startswith(h) or h.startswith(oid)) and num not in our_prs and near(ts, at):
                return "foreign", 0.0
        for oid, at in foreign_closers.get(h[:7], []):
            if (oid.startswith(h) or h.startswith(oid)) and near(ts, at):
                return "foreign", 0.0
        return "neutral", 0.0

    intervals = []          # (a, b) без веса — для объединения между сессиями
    raw_total = weighted_total = 0.0
    seen_prs, seen_branches, seen_hashes = set(), set(), set()
    n_sessions = n_prompts = 0
    first_ts = last_ts = None
    details = []
    our_key = f"{repo.full}#{number}"

    for s in sessions:
        ev = s["ev"]
        if not ev:
            continue
        for _, pr in s["prlinks"]:
            seen_prs.add(pr)
        for e in ev:
            if e[1]:
                seen_branches.add(e[1])
        anchors = []  # (ts, cls, kind, доля)
        for ts, pr in s["prlinks"]:
            anchors.append((ts, "own" if pr in our_prs else "foreign", "pr", pr_w.get(pr, 0.0)))
        for ts, h in s["commits"]:
            cls, w = hash_class(h, ts)
            if cls == "own":
                seen_hashes.add(h)
            if cls != "neutral":
                anchors.append((ts, cls, "commit", w))
        anchors.sort()
        foreign_ts = [a[0] for a in anchors if a[1] == "foreign"]

        # окна по якорям: от предыдущего чужого якоря до своего; внутри окна считаются только
        # записи на ветке якоря или на нейтральной ветке (HEAD/пусто/main…) — чужие ветки нет.
        windows = []  # (start, end, branch|None, доля)
        prev_foreign = -1e18
        for ts, cls, kind, w in anchors:
            if cls == "foreign":
                prev_foreign = ts
                continue
            start, end = prev_foreign, ts
            br_at = ""
            for e in ev:
                if e[0] > ts:
                    break
                if not is_neutral(e[1]):
                    br_at = e[1]
            if kind == "pr":
                # хвост после pr-link: пока ветка та же и нет чужого якоря (правки после ревью)
                nxt_foreign = min([t for t in foreign_ts if t > ts] or [1e18])
                for e in ev:
                    if e[0] <= ts:
                        continue
                    if e[0] >= nxt_foreign or e[1] != br_at:
                        break
                    end = e[0]
            windows.append((start, end, br_at, w))
        # номер задачи в первом промпте (и только он): от начала сессии до первого чужого якоря
        # или до первого перехода на ветку, которая не наша и не нейтральная
        refs = set(s["first_refs"]) | {int(u.split("#")[1]) for u in s.get("first_urls", []) if u.startswith(repo.full + "#")}
        if refs == {number}:
            # (или до первого перехода на ветку, которая не наша и не нейтральная; стартовая ветка
            # сессии допускается, если она не чужая — на ней и делалась задача из первого промпта)
            end = min(foreign_ts or [1e18])
            start_branch = None
            for e in ev:
                if e[0] >= end:
                    break
                b = e[1]
                if is_neutral(b) or is_our_branch(b):
                    continue
                if is_foreign_branch(b) or (start_branch is not None and b != start_branch):
                    end = e[0]
                    break
                start_branch = b
            windows.append((-1e18, end, None, 1.0))

        attributed = []  # доля (0 — не наша запись)
        rules = {}
        for e in ev:
            ts, b, human = e[0], e[1], e[2]
            hint = e[3] if len(e) > 3 else ""
            w = 0.0
            if hint:
                # запись субагента, задание которого называет задачу: своя — целиком,
                # чужая — не наша, какие бы ветки/окна ни были
                if hint == str(number) or hint == our_key:
                    w = 1.0
                    rules["субагент"] = rules.get("субагент", 0) + 1
                attributed.append(w)
                continue
            if is_our_branch(b):
                w = branch_w(b)
                rules["ветка"] = rules.get("ветка", 0) + 1
            elif windows and not is_foreign_branch(b):
                ws = [ww for a, z, wb, ww in windows
                      if a <= ts <= z and (wb is None or b == wb or is_neutral(b))]
                if ws:
                    w = max(ws)
                    rules["якорь"] = rules.get("якорь", 0) + 1
            attributed.append(w)
        if not any(attributed):
            continue
        # интервал до предыдущей записи считается, только если она тоже наша
        # или это человеческий промпт, с которого начался наш сегмент
        sess_raw = sess_w = 0.0
        prompts = 0
        s_first = s_last = None
        brs = {}
        for i, e in enumerate(ev):
            ts, b, human = e[0], e[1], e[2]
            w = attributed[i]
            if human and not w and i + 1 < len(ev) and attributed[i + 1] and ev[i + 1][0] - ts <= gap:
                prompts += 1
            if not w:
                continue
            prompts += human
            s_first = ts if s_first is None else s_first
            s_last = ts
            if i > 0 and ts - ev[i - 1][0] <= gap and (attributed[i - 1] or ev[i - 1][2]):
                d = ts - ev[i - 1][0]
                intervals.append((ev[i - 1][0], ts))
                sess_raw += d
                sess_w += d * w
                brs[b or "?"] = brs.get(b or "?", 0) + d * w / 3600
        if sess_raw < 60 and prompts == 0:
            continue  # меньше минуты и без промптов (случайный хеш в выводе) — сессией не считаем
        n_sessions += 1
        n_prompts += prompts
        raw_total += sess_raw
        weighted_total += sess_w
        first_ts = s_first if first_ts is None else min(first_ts, s_first)
        last_ts = s_last if last_ts is None else max(last_ts, s_last)
        details.append({"sid": s["sid"], "start": s_first, "hours": round(sess_w / 3600, 2), "prompts": prompts,
                        "rules": rules, "branches": {k: round(v, 2) for k, v in sorted(brs.items(), key=lambda x: -x[1])}})

    merged = merge_intervals(intervals)
    active_raw = sum(b - a for a, b in merged)                 # без двойного счёта между сессиями
    overlap = (active_raw / raw_total) if raw_total > 0 else 1.0
    active = weighted_total * overlap / 3600

    # покрытие
    def pr_seen(p):
        return (p["number"] in seen_prs or (p["headRefName"] and p["headRefName"] in seen_branches)
                or any(hash_matches(h, {c["oid"] for c in p["commits"]}) for h in seen_hashes))
    units = [pr_seen(p) for p in pr_objs] + [any(hash_matches(h, {c["oid"]}) for h in seen_hashes) for c in closers]
    if n_sessions == 0:
        cov = "none"
    elif units and all(units):
        cov = "full"
    else:
        cov = "partial"

    diff = sum(diff_size(p) for p in pr_objs)
    diff_na = False
    for c in closers:
        d = repo.commit_diff(c["oid"])
        if d is None:
            diff_na = True
        else:
            diff += d
    res = {
        "issue": number,
        "h": round(active, 2) if cov != "none" else None,
        "h_raw": round(active_raw / 3600, 2) if cov != "none" else None,
        "wall": round((last_ts - first_ts) / 3600, 1) if first_ts is not None and cov != "none" else None,
        "cov": cov, "sessions": n_sessions, "prompts": n_prompts,
        "prs": [p["number"] for p in pr_objs],
        "commits": sum(p["commits_total"] or len(p["commits"]) for p in pr_objs) + len(closers),
        "diff": diff, "diff_na": diff_na,
        "shared": shared,
        "first": first_ts, "last": last_ts,
        "intervals": merged,
        "details": sorted(details, key=lambda d: d["start"]),
    }
    return res



def merge_intervals(iv):
    iv = sorted(iv)
    out = []
    for a, b in iv:
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


# ----------------------------------------------------------------------------
# Комментарии с маркерами (fact / est)
# ----------------------------------------------------------------------------

def find_marker_comment(issue, kind):
    for c in issue["comments"]["nodes"]:
        if parse_marker(c["body"], kind) is not None:
            return c
    return None


def extract_kept_lines(body):
    """Строки «+ вручную: N ч» и «Причина: …», дописанные человеком."""
    manual, cause, lines = 0.0, None, []
    for line in (body or "").splitlines():
        s = line.strip()
        m = re.match(r"\+\s*вручную:\s*([\d.,]+)\s*ч", s, re.I)
        if m:
            manual = float(m.group(1).replace(",", "."))
            lines.append(s)
        elif re.match(r"Причина:", s, re.I):
            cause = s.split(":", 1)[1].strip()
            lines.append(s)
    return manual, cause, lines


def fact_comment_body(res, est, kept_lines, manual, cause):
    h = res["h"]
    if h is None:
        text = f"Факт недоступен: сессии не найдены (покрытие none)."
    else:
        ratio = f", ×{h / est:.2f}" if est else ""
        est_txt = f"оценка {fmt_h(est)} ч{ratio}" if est else "оценки нет"
        ns, npr = res["sessions"], res["prompts"]
        text = (f"Факт: {fmt_h(h)} ч активных в Claude Code ({est_txt}). "
                f"{ns} {plural(ns, 'сессия', 'сессии', 'сессий')}, {npr} {plural(npr, 'промпт', 'промпта', 'промптов')}, "
                f"стена {fmt_h(res['wall'], 1)} ч, покрытие {res['cov']}.")
    if res["prs"]:
        text += " PR " + ", ".join(f"#{p}" for p in res["prs"]) + ";"
    else:
        text += " PR нет;"
    nc = res["commits"]
    text += f" {nc} {plural(nc, 'коммит', 'коммита', 'коммитов')}, дифф {diff_txt(res)}."
    if res.get("shared"):
        text += " " + shared_txt(res) + "."
    marker = {"v": 1, "h": h, "manual": manual, "wall": res["wall"], "cov": res["cov"],
              "sessions": res["sessions"], "prompts": res["prompts"], "prs": res["prs"],
              "commits": res["commits"], "diff": res["diff"], "cause": cause}
    if res.get("type"):
        marker["type"] = res["type"]   # тип из ветки по конвенции <type>/N-slug
    if res.get("shared"):
        marker["shared"] = {s["unit"]: s["with"] for s in res["shared"]}
    parts = [text] + kept_lines + [f"<!-- fact {json.dumps(marker, ensure_ascii=False)} -->"]
    return "\n".join(parts)


def diff_txt(res):
    if res.get("diff_na"):
        return "н/д (без PR)"
    return f"{res['diff']} строк"


def shared_txt(res):
    """«общий коммит a9e2854 с #7, #8 (доля 1/3)»."""
    parts = []
    for s in res.get("shared") or []:
        parts.append(f"общий {s['unit']} с {', '.join('#%d' % n for n in s['with'])} (доля 1/{s['k']})")
    return "; ".join(parts)


def upsert_comment(repo, issue, kind, body):
    existing = find_marker_comment(issue, kind)
    if existing:
        gh_rest(f"repos/{repo.full}/issues/comments/{existing['databaseId']}", "PATCH", {"body": body})
        return "обновлён"
    gh_rest(f"repos/{repo.full}/issues/{issue['number']}/comments", "POST", {"body": body})
    return "создан"


def set_number_field(repo, issue, field_name, value):
    meta = repo.project_meta()
    vals = issue_project_fields(issue, meta)
    item_id = vals["item_id"]
    if not item_id:
        q = "mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }"
        item_id = gh_graphql(q, {"p": meta["id"], "c": issue["id"]})["addProjectV2ItemById"]["item"]["id"]
    q = """mutation($p:ID!,$i:ID!,$f:ID!,$v:Float!){
      updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{number:$v}}){ projectV2Item{ id } } }"""
    try:
        gh_graphql(q, {"p": meta["id"], "i": item_id, "f": meta["fields"][field_name]["id"], "v": float(value)})
    except EstError as e:
        if not (err_is(e, "not found") or err_is(e, "could not resolve")):
            raise
        # устаревший кэш id проекта/поля — перечитать и повторить один раз
        meta = repo.project_meta(force=True)
        gh_graphql(q, {"p": meta["id"], "i": item_id, "f": meta["fields"][field_name]["id"], "v": float(value)})


# ----------------------------------------------------------------------------
# История и k
# ----------------------------------------------------------------------------

def calib(rows, last=20):
    """k = медиана(факт/оценка) по последним `last` закрытым задачам с маркером est и фактом."""
    cands = []
    n_partial = 0
    for r in rows:
        if r["state"] != "CLOSED" or r["fact"] is None or not r["est_marker"]:
            continue
        est = r["est_marker"].get("h") or r["est"]
        if not est or est <= 0:
            continue
        fm = r.get("fact_marker")
        if fm and fm.get("cov") not in (None, "full"):
            n_partial += 1  # неполное покрытие транскриптами — в k не берём (см. вывод history)
            continue
        cands.append((r["closedAt"] or 0, r["fact"] / est))
    cands.sort(key=lambda x: -x[0])
    ratios = sorted(x[1] for x in cands[:last])
    if not ratios:
        return {"k": None, "n": 0, "p25": None, "p75": None, "share": None, "n_partial": n_partial}
    return {"k": round(statistics.median(ratios), 2), "n": len(ratios),
            "p25": round(quantile(ratios, 0.25), 2), "p75": round(quantile(ratios, 0.75), 2),
            "share": round(sum(1 for x in ratios if 0.5 <= x <= 2) / len(ratios), 2), "n_partial": n_partial}


def k_decision(k, n):
    """Правило применения k: n<5 — нет; 5–9 — если |k−1|≥0.25; ≥10 — всегда; k вне 0.5…3 — нет."""
    if k is None or n == 0:
        return False, "истории нет"
    if not (0.5 <= k <= 3):
        return False, f"k={k} вне 0.5…3 — процедура сломана, не применять"
    if n < 5:
        return False, f"n={n} < 5"
    if n < 10:
        return (abs(k - 1) >= 0.25), (f"n={n}, |k−1|≥0.25" if abs(k - 1) >= 0.25 else f"n={n}, |k−1|<0.25")
    return True, f"n={n} ≥ 10"


def cmd_history(args):
    registry = load_registry()
    repos = list(registry) if args.all_repos else [resolve_repo(args.repo)]
    now = datetime.now(timezone.utc).timestamp()
    summary = []
    for full in repos:
        repo = Repo(full, registry)
        rows = repo.project_rows()
        rows_fact = [r for r in rows if r["state"] == "CLOSED" and r["fact"] is not None]
        if args.grep:
            g = args.grep.lower()
            rows_fact = [r for r in rows_fact if g in r["title"].lower() or any(g in l.lower() for l in r["labels"])]
        rows_fact.sort(key=lambda r: -(r["closedAt"] or 0))
        if args.last:
            rows_fact = rows_fact[: args.last]
        c = calib(rows)
        no_fact_90 = sum(1 for r in rows if r["state"] == "CLOSED" and r["fact"] is None
                         and r.get("stateReason") != "NOT_PLANNED" and (r["closedAt"] or 0) >= now - 90 * 86400)
        summary.append((full, len([r for r in rows if r["state"] == "CLOSED" and r["fact"] is not None]),
                        statistics.median([r["fact"] for r in rows if r["fact"] is not None]) if any(r["fact"] is not None for r in rows) else None, c))
        print(f"== {full} (проект {repo.project_meta()['owner']} #{repo.project_meta()['number']})")
        if not rows_fact:
            print("история пуста" + (f" (фильтр «{args.grep}»)" if args.grep else ""))
        else:
            print(f"{'№':>5} | {'оценка':>6} | {'факт':>6} | {'тип':<8} | {'метки':<22} | заголовок")
            for r in rows_fact:
                typ = (r["est_marker"] or {}).get("type") or (r.get("fact_marker") or {}).get("type") or ""
                labels = ",".join(l for l in r["labels"] if l != "epic")[:22]
                print(f"{r['number']:>5} | {fmt_h(r['est']):>6} | {fmt_h(r['fact']):>6} | {typ:<8} | {labels:<22} | {r['title'][:70]}")
        if c["n"]:
            print(f"k = {c['k']} (n={c['n']}, p25–p75 {c['p25']}–{c['p75']}); доля в допуске ×0.5…×2: {int(c['share'] * 100)} %")
        else:
            print("k: нет пар «оценка с маркером est + факт» — калибровка недоступна")
        if c.get("n_partial"):
            print(f"в k не вошли задачи с покрытием partial/none: {c['n_partial']}")
        print(f"закрытых за 90 дней без факта: {no_fact_90}")
        print()
    if args.all_repos:
        print("== сводка по всем репозиториям")
        for full, nf, med, c in summary:
            print(f"  {full}: фактов {nf}, медиана факта {fmt_h(med)} ч, k={c['k']} (n={c['n']})")


def calib_for_estimate(repo, registry):
    """k по репо, иначе по всем репо (n≥5), иначе нет."""
    rows = repo.project_rows()
    c = calib(rows)
    level = "репо"
    if c["n"] < 5:
        all_rows = list(rows)
        for full in registry:
            if full != repo.full:
                try:
                    all_rows += Repo(full, registry).project_rows()
                except EstError as e:
                    print(f"предупреждение: {full}: {e}", file=sys.stderr)
        c2 = calib(all_rows)
        if c2["n"] >= 5:
            c, level = c2, "все репо"
    return rows, c, level


# ----------------------------------------------------------------------------
# Команда fact
# ----------------------------------------------------------------------------

def fact_for_issue(repo, number, gap, quiet=False):
    try:
        issue = fetch_issue(repo, number)
    except NotAnIssue:
        pr = repo.pr(number)
        if not pr:
            raise EstError(f"#{number} не найден в {repo.full} ни как issue, ни как PR")
        return fact_for_pr(repo, pr, gap)
    labels = [l["name"] for l in issue["labels"]["nodes"]]
    itype = ((issue.get("issueType") or {}).get("name") or "").lower()
    # эпик — по типу issue «Эпик»/«Epic»; метка epic — запасной вариант для репо без типов
    if itype in ("эпик", "epic") or "epic" in labels:
        return fact_for_epic(repo, issue, gap, quiet)
    pr_objs, closers, weak_used = resolve_links(repo, issue)
    res = compute_fact(repo, number, pr_objs, closers, gap)
    res["title"] = issue["title"]
    res["weak_links"] = weak_used
    res["links"] = [{"pr": p["number"], "branch": p["headRefName"], "why": p["why"]} for p in pr_objs]
    res["type"] = next((branch_type(l["branch"]) for l in res["links"] if branch_type(l["branch"])), None)
    res["closers"] = [c["oid"][:7] for c in closers]
    res["epic"] = False
    return issue, res


def fact_for_pr(repo, pr, gap):
    """Номер оказался PR, а не issue: считаем факт по самому PR (без записи)."""
    res = compute_fact(repo, pr["number"], [dict(pr, why="сам PR")], [], gap)
    res["title"] = pr["title"] or ""
    res["weak_links"] = False
    res["links"] = [{"pr": pr["number"], "branch": pr["headRefName"], "why": "это PR, не issue"}]
    res["closers"] = []
    res["epic"] = False
    res["is_pr"] = True
    pseudo = {"number": pr["number"], "title": pr["title"], "labels": {"nodes": []}, "comments": {"nodes": []},
              "projectItems": {"nodes": []}, "id": None, "is_pr": True}
    return pseudo, res


def fact_for_epic(repo, issue, gap, quiet=False):
    """Факт эпика = сумма фактов подзадач: из поля «Факт, ч» (+ «вручную» из маркера), а для подзадач
    без поля — по транскриптам."""
    number = issue["number"]
    subs = []
    page = 1
    while True:
        chunk = gh_rest(f"repos/{repo.full}/issues/{number}/sub_issues?per_page=100&page={page}") or []
        subs += chunk
        if len(chunk) < 100:
            break
        page += 1
    rows = {r["number"]: r for r in repo.project_rows()}
    total = 0.0
    parts = []
    missing = 0
    for s in subs:
        row = rows.get(s["number"])
        if row and row.get("fact") is not None:
            manual = float((row.get("fact_marker") or {}).get("manual") or 0)
            h = row["fact"] + manual
            cov = (row.get("fact_marker") or {}).get("cov") or "поле"
            src = "поле «Факт, ч»" + (f" + вручную {fmt_h(manual)} ч" if manual else "")
        else:
            _, r = fact_for_issue(repo, s["number"], gap, quiet=True)
            h, cov, src = r["h"], r["cov"], "транскрипты"
        parts.append({"issue": s["number"], "state": s["state"], "h": h, "cov": cov, "src": src, "title": s["title"]})
        if h is None:
            missing += 1
        else:
            total += h
    res = {
        "issue": number, "title": issue["title"], "epic": True,
        "h": round(total, 2) if subs and missing < len(subs) else None,
        "wall": None, "cov": "full" if subs and missing == 0 else ("partial" if missing < len(subs) else "none"),
        "sessions": 0, "prompts": 0, "prs": [], "commits": 0, "diff": 0, "shared": [], "intervals": [],
        "subtasks": parts, "sub_missing": missing, "details": [], "links": [], "closers": [], "weak_links": False,
    }
    return issue, res


def print_fact(repo, issue, res, est):
    print(f"== {repo.full}#{res['issue']}: {res['title']}")
    if res.get("is_pr"):
        print(f"ВНИМАНИЕ: #{res['issue']} — это PR, а не issue; факт посчитан по самому PR, запись невозможна")
    if res.get("epic"):
        print(f"эпик: {len(res['subtasks'])} подзадач, без факта: {res['sub_missing']}")
        for p in res["subtasks"]:
            print(f"  #{p['issue']:<5} {p['state']:<6} {fmt_h(p['h']):>6} ч  {p['cov']:<7} {p['title'][:50]:<50} [{p['src']}]")
        print(f"факт эпика: {fmt_h(res['h'])} ч (сумма подзадач с фактом), покрытие {res['cov']}")
        return
    if res["links"]:
        for l in res["links"]:
            print(f"PR #{l['pr']} (ветка {l['branch']}) — {l['why']}" + ("  [СЛАБАЯ СВЯЗЬ]" if res["weak_links"] else ""))
    if res["closers"]:
        print("закрыт коммитом: " + ", ".join(res["closers"]))
    if not res["links"] and not res["closers"]:
        print("PR и коммиты не найдены — привязка только по ветке/первому промпту")
    if res.get("shared"):
        print("ВНИМАНИЕ: " + shared_txt(res) + " — часы поделены между задачами")
    if res["h"] is None:
        print("факт недоступен: сессии не найдены (покрытие none)")
    else:
        est_txt = f"оценка {fmt_h(est)} ч, ×{res['h'] / est:.2f}" if est else "оценки нет"
        raw = f" (без деления: {fmt_h(res['h_raw'])} ч)" if res.get("shared") and res.get("h_raw") is not None else ""
        print(f"факт: {fmt_h(res['h'])} ч активных в Claude Code{raw} ({est_txt}); "
              f"{res['sessions']} сесс., {res['prompts']} промптов, стена {fmt_h(res['wall'], 1)} ч, покрытие {res['cov']}")
    print(f"вторичное: PR {', '.join('#%d' % p for p in res['prs']) or 'нет'}; коммитов {res['commits']}; дифф {diff_txt(res)} (без lock/снапшотов/минифицированного)")
    for d in res["details"]:
        brs = ", ".join(f"{b} {h} ч" for b, h in list(d["branches"].items())[:4])
        rules = ", ".join(f"{k}:{v}" for k, v in d["rules"].items())
        print(f"  сессия {d['sid'][:8]} {fmt_local(d['start'])}: {d['hours']} ч, {d['prompts']} промптов [{rules}] — {brs}")


def write_fact(repo, issue, res, est):
    if res.get("is_pr"):
        raise EstError(f"#{res['issue']} — это PR, а не issue: факт по PR не записывается")
    existing = find_marker_comment(issue, "fact")
    manual, cause, kept = extract_kept_lines(existing["body"] if existing else "")
    body = fact_comment_body(res, est, kept, manual, cause)
    what = upsert_comment(repo, issue, "fact", body)
    msg = f"комментарий «Факт» {what}"
    if res["h"] is not None:
        set_number_field(repo, issue, FIELD_FACT, res["h"])
        msg += f", поле «{FIELD_FACT}» = {fmt_h(res['h'])}"
    print(msg)


def cmd_fact(args):
    registry = load_registry()
    if args.gap < 1:
        raise EstError(f"--gap должен быть ≥ 1 минуты, получено {args.gap}")
    if args.sweep and args.number is not None:
        raise EstError("номер issue и --sweep несовместимы: либо одно, либо другое")
    repo = Repo(resolve_repo(args.repo), registry)
    meta = repo.project_meta()
    if args.sweep:
        since = parse_since(args.since)
        now = datetime.now(timezone.utc).timestamp()
        rows = [r for r in repo.project_rows()
                if r["state"] == "CLOSED" and r["fact"] is None and r.get("stateReason") != "NOT_PLANNED"
                and (r["closedAt"] or 0) >= now - since]
        rows.sort(key=lambda r: -(r["closedAt"] or 0))
        print(f"== {repo.full}: закрытых без факта за {args.since}: {len(rows)}")
        stats = {"full": 0, "partial": 0, "none": 0}
        total = 0.0
        epics_total = 0.0
        all_iv = []
        for r in rows:
            try:
                issue, res = fact_for_issue(repo, r["number"], args.gap, quiet=True)
            except EstError as e:
                print(f"  #{r['number']}: ошибка: {e}")
                continue
            stats[res["cov"]] += 1
            h = res["h"]
            if h is not None:
                if res.get("epic"):
                    epics_total += h  # эпик — сумма подзадач, в общий итог не входит (иначе двойной счёт)
                else:
                    total += h
                    all_iv += res.get("intervals") or []
            extra = "эпик" if res.get("epic") else ("PR " + ", ".join("#%d" % p for p in res["prs"]) if res["prs"] else "без PR")
            if res.get("weak_links"):
                extra += " (слабая связь)"
            if res.get("shared"):
                extra += " (доля 1/%d)" % max(s["k"] for s in res["shared"])
            print(f"  #{r['number']:<5} {fmt_h(h):>6} ч  {res['cov']:<7} оценка {fmt_h(r['est']):>5}  {extra:<26} {r['title'][:50]}")
            if args.write and res["cov"] != "none":
                write_fact(repo, issue, res, r["est"])
        union_h = sum(b - a for a, b in merge_intervals(all_iv)) / 3600
        print(f"итого: full {stats['full']}, partial {stats['partial']}, none {stats['none']}; "
              f"сумма часов {fmt_h(total)} (без эпиков; эпики {fmt_h(epics_total)} ч — сумма своих подзадач)")
        if total - union_h > 0.05:
            print(f"ВНИМАНИЕ: интервалы задач пересекаются: сумма {fmt_h(total)} ч при объединении {fmt_h(union_h)} ч "
                  f"— двойной счёт ≈ {fmt_h(total - union_h)} ч")
        if not args.write:
            print("(без --write ничего не записано)")
        return
    if args.number is None:
        raise EstError("укажите номер issue или --sweep")
    issue, res = fact_for_issue(repo, args.number, args.gap)
    est = issue_project_fields(issue, meta)["est"]
    if args.json:
        out = dict(res)
        out["est"] = est
        out.pop("details", None)
        out.pop("intervals", None)
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print_fact(repo, issue, res, est)
    if args.write:
        write_fact(repo, issue, res, est)
    elif not args.json:
        print("(без --write ничего не записано)")


# ----------------------------------------------------------------------------
# Команда estimate
# ----------------------------------------------------------------------------

def cmd_estimate(args):
    registry = load_registry()
    repo = Repo(resolve_repo(args.repo), registry)
    meta = repo.project_meta()
    if args.type not in EST_TYPES:
        raise EstError(f"--type должен быть одним из: {', '.join(EST_TYPES)}")
    if not (args.hours > 0):
        raise EstError(f"--hours должен быть больше 0, получено {fmt_h(args.hours)}")
    analogs = []
    if args.analogs:
        for a in args.analogs.split(","):
            a = a.strip().lstrip("#")
            if a:
                if not a.isdigit():
                    raise EstError(f"аналог «{a}» — не номер issue")
                if int(a) == args.number:
                    raise EstError(f"аналог #{a} — это сама оцениваемая задача")
                if int(a) not in analogs:
                    analogs.append(int(a))
    if args.mult not in (0.5, 1, 1.5, 2):
        raise EstError("--mult допускает только 0.5, 1, 1.5 или 2")
    rows, c, level = calib_for_estimate(repo, registry)
    by_num = {r["number"]: r for r in rows}
    # аналоги: нет в репо — ошибка; есть в репо, но не в проекте — предупреждение, в доверие не входит
    counted = 0
    parts = []
    for a in analogs:
        r = by_num.get(a)
        if r is None:
            try:
                fetch_issue(repo, a)
            except EstError as e:
                raise EstError(f"аналог #{a} не найден в репо {repo.full} как issue ({e})")
            print(f"предупреждение: аналог #{a} есть в репо, но не в проекте — факт неизвестен", file=sys.stderr)
            parts.append(f"#{a} (нет в проекте)")
            continue
        counted += 1
        if r["fact"] is None:
            parts.append(f"#{a} (факт неизвестен)")
        else:
            parts.append(f"#{a} (факт {fmt_h(r['fact'])} ч)")
    apply_k, why = k_decision(c["k"], c["n"])
    same_type = sum(1 for r in rows if r["state"] == "CLOSED" and r["fact"] is not None
                    and (r["est_marker"] or {}).get("type") == args.type)
    if counted and same_type >= 5 and apply_k:
        conf = "A"
    elif counted >= 2:
        conf = "B"
    else:
        conf = "C"
    analog_txt = ", ".join(parts) if parts else "нет, оценка экспертная"
    note = f" ({args.note})" if args.note else ""
    k_txt = (f"k={c['k']} (n={c['n']}, уровень «{level}», {'применён' if apply_k else 'не применён'}: {why})"
             if c["n"] else "k: истории нет (не применён)")
    text = (f"Оценка: {fmt_h(args.hours)} ч (тип {args.type}, доверие {conf}). "
            f"Аналоги: {analog_txt}. Поправка: ×{fmt_h(args.mult)}{note}. {k_txt}.")
    marker = {"v": 1, "h": args.hours, "type": args.type, "analogs": analogs, "mult": args.mult,
              "k": c["k"], "n": c["n"], "k_applied": bool(apply_k), "conf": conf}
    body = text + "\n" + f"<!-- est {json.dumps(marker, ensure_ascii=False)} -->"
    issue = fetch_issue(repo, args.number)
    cur = issue_project_fields(issue, meta)
    print(f"== {repo.full}#{args.number}: {issue['title']}")
    print(f"текущая «{FIELD_EST}»: {fmt_h(cur['est'])}; статус: {cur['status'] or '—'}")
    if c["n"] and not apply_k and not (0.5 <= (c["k"] or 1) <= 3):
        print(f"ВНИМАНИЕ: {why}")
    if args.hours > 13:
        print("ВНИМАНИЕ: оценка > 13 ч — по протоколу задачу надо дробить на подзадачи")
    print("комментарий:")
    print(body)
    if args.write:
        what = upsert_comment(repo, issue, "est", body)
        set_number_field(repo, issue, FIELD_EST, args.hours)
        print(f"комментарий «Оценка» {what}, поле «{FIELD_EST}» = {fmt_h(args.hours)}")
    else:
        print("(без --write ничего не записано)")


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(prog="est", description="Оценка задач по истории проекта и факт из транскриптов Claude Code.")
    sub = p.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("history", help="таблица закрытых задач с фактом и калибровка k")
    h.add_argument("--repo", help="owner/repo (по умолчанию из git remote origin)")
    h.add_argument("--grep", help="фильтр по слову в заголовке или метках")
    h.add_argument("--all-repos", action="store_true", help="по всем репозиториям из реестра")
    h.add_argument("--last", type=int, help="показать только N последних строк")
    h.set_defaults(func=cmd_history)

    f = sub.add_parser("fact", help="факт по транскриптам Claude Code для issue")
    f.add_argument("number", type=int, nargs="?", help="номер issue")
    f.add_argument("--repo", help="owner/repo (по умолчанию из git remote origin)")
    f.add_argument("--write", action="store_true", help="записать комментарий «Факт» и поле «Факт, ч»")
    f.add_argument("--gap", type=int, default=30, help="максимальная пауза между записями, мин, ≥ 1 (по умолчанию 30)")
    f.add_argument("--json", action="store_true", help="вывести результат в JSON")
    f.add_argument("--sweep", action="store_true", help="все закрытые без факта за период")
    f.add_argument("--since", default="90d", help="период для --sweep: 90d, 12w, 6m (по умолчанию 90d)")
    f.set_defaults(func=cmd_fact)

    e = sub.add_parser("estimate", help="записать оценку с аналогами и маркером")
    e.add_argument("number", type=int, help="номер issue")
    e.add_argument("--repo", help="owner/repo (по умолчанию из git remote origin)")
    e.add_argument("--hours", type=float, required=True, help="оценка, ч (уже с учётом поправки и k)")
    e.add_argument("--type", required=True, choices=EST_TYPES, help="тип задачи")
    e.add_argument("--analogs", default="", help="номера аналогов через запятую: 254,260")
    e.add_argument("--mult", type=float, default=1, help="поправка: 0.5, 1, 1.5 или 2")
    e.add_argument("--note", default="", help="причина поправки")
    e.add_argument("--write", action="store_true", help="записать комментарий «Оценка» и поле «Оценка, ч»")
    e.set_defaults(func=cmd_estimate)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except EstError as e:
        die(str(e))
    except KeyboardInterrupt:
        die("прервано", 130)


if __name__ == "__main__":
    main()
