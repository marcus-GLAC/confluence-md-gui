"""Confluence → Markdown GUI.

Giao diện web chạy local (127.0.0.1) bọc quanh confluence-markdown-exporter (cme):
export page/space, kiểm tra link ảnh, xem trước .md và đẩy lên GitHub.

Chạy:  cme-gui                   → mở trình duyệt
       cme-gui --port 8000      → cố định cổng
       cme-gui cme ...          → chạy thẳng CLI cme
"""

from __future__ import annotations

import base64
import hashlib
import html
import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_NAME = "ConfluenceMdGui"
STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = Path(os.environ.get("APPDATA") or Path.home() / ".config") / APP_NAME
SETTINGS_FILE = DATA_DIR / "settings.json"
CME_CONFIG_FILE = DATA_DIR / "cme_config.json"
DEFAULT_OUTPUT = r"C:\cme-export" if os.name == "nt" else str(Path.home() / "cme-export")
# API tạo blob của GitHub từ chối file lớn (thực tế khoảng 40MB sau khi mã hoá base64).
GITHUB_MAX_FILE = 40 * 1024 * 1024
EXPORT_MODES = {"pages", "pages-with-descendants", "folders", "spaces"}
SESSION = secrets.token_urlsafe(24)
# Client ID của GitHub OAuth App (bật Device Flow). Không phải bí mật, được phép công khai.
GITHUB_CLIENT_ID = os.environ.get("CME_GUI_GITHUB_CLIENT_ID", "Ov23liFG0NmCelT4uXMu")
KEYRING_USER = "github-token"


# ---------------------------------------------------------------- settings

def load_settings() -> dict:
    defaults = {"base_url": "", "email": "", "output": DEFAULT_OUTPUT, "repo": "", "branch": "main", "subdir": ""}
    try:
        defaults.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return defaults


def save_settings(values: dict) -> None:
    # Token không bao giờ được lưu xuống đĩa.
    current = load_settings()
    current.update({k: v for k, v in values.items() if k in current and isinstance(v, str)})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- jobs

class Job:
    """Một tác vụ chạy nền (export hoặc push) với log để giao diện hỏi định kỳ."""

    lock = threading.Lock()
    current: "Job | None" = None

    def __init__(self, kind: str):
        self.kind = kind
        self.lines: list[str] = []
        self.running = True
        self.ok: bool | None = None
        self.proc: subprocess.Popen | None = None
        self.cancelled = False
        self.result: dict = {}

    def log(self, text: str) -> None:
        self.lines.extend(text.rstrip("\n").split("\n"))

    def finish(self, ok: bool) -> None:
        self.ok = ok
        self.running = False

    @classmethod
    def start(cls, kind: str, target, *args) -> "Job":
        with cls.lock:
            if cls.current and cls.current.running:
                raise ValueError("Đang có một tác vụ chạy, vui lòng đợi hoặc bấm Dừng.")
            job = cls(kind)
            cls.current = job

        def runner():
            try:
                job.finish(bool(target(job, *args)))
            except Exception as exc:  # noqa: BLE001 - hiện mọi lỗi lên giao diện
                job.log(f"❌ Lỗi: {exc}")
                job.finish(False)

        threading.Thread(target=runner, daemon=True).start()
        return job


def cme_command(*args: str) -> list[str]:
    return [sys.executable, "-m", "confluence_md_gui", "cme", *args]


def run_export(job: Job, p: dict) -> bool:
    base_url = p["base_url"].strip().rstrip("/")
    output = Path(p["output"]).expanduser()
    output.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env.update({
        "CME_CONFIG_PATH": str(CME_CONFIG_FILE),
        "CME_NON_INTERACTIVE": "1",
        "NO_COLOR": "1",
        "CI": "true",
        "COLUMNS": "160",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "CME_EXPORT__OUTPUT_PATH": str(output),
        "CME_EXPORT__ENABLE_JIRA_ENRICHMENT": "false",
        "CME_AUTH__CONFLUENCE": json.dumps({base_url: {"username": p["email"].strip(), "api_token": p["token"].strip()}}),
    })
    cmd = cme_command(p["mode"], p["target_url"].strip())
    job.log(f"▶ cme {p['mode']} {p['target_url'].strip()}")
    job.log(f"  Thư mục lưu: {output}")

    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    job.proc = subprocess.Popen(
        cmd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        encoding="utf-8", errors="replace", creationflags=flags,
    )
    for line in job.proc.stdout:
        job.log(line)
    code = job.proc.wait()
    if job.cancelled:
        job.log("⏹ Đã dừng.")
        return False
    if code == 0:
        job.log("✅ Export xong. Sang tab 2 để kiểm tra ảnh.")
    else:
        job.log(f"❌ cme kết thúc với mã lỗi {code}. Hãy kiểm tra lại địa chỉ Confluence, email, "
                "API token và quyền xem trang.")
    return code == 0


# ---------------------------------------------------------------- link check

IMG_MD = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
IMG_HTML = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.I)


def safe_path(root: Path, rel: str) -> Path:
    root = root.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError("Đường dẫn nằm ngoài thư mục export.")
    return target


def check_links(output: Path, strip_query: bool) -> dict:
    report = {"files": 0, "images": 0, "remote": [], "query": [], "missing": [], "too_big": [], "fixed": 0}
    if not output.is_dir():
        raise ValueError(f"Không tìm thấy thư mục {output}")
    for md in sorted(output.rglob("*.md")):
        rel_md = md.relative_to(output).as_posix()
        text = md.read_text(encoding="utf-8", errors="replace")
        report["files"] += 1
        new_text = text
        for src in [m.group(1) for m in IMG_MD.finditer(text)] + [m.group(1) for m in IMG_HTML.finditer(text)]:
            report["images"] += 1
            parsed = urllib.parse.urlparse(src)
            if parsed.scheme in ("http", "https"):
                report["remote"].append({"file": rel_md, "src": src})
                continue
            if parsed.scheme == "data":
                continue
            if parsed.query:
                report["query"].append({"file": rel_md, "src": src})
                if strip_query:
                    new_text = new_text.replace(src, src.split("?", 1)[0])
            local = (md.parent / urllib.parse.unquote(parsed.path)).resolve()
            if not local.exists():
                report["missing"].append({"file": rel_md, "src": src})
        if new_text != text:
            md.write_text(new_text, encoding="utf-8")
            report["fixed"] += 1
    for f in output.rglob("*"):
        if f.is_file() and f.stat().st_size > GITHUB_MAX_FILE:
            report["too_big"].append(f.relative_to(output).as_posix())
    return report


# ---------------------------------------------------------------- preview

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp"}


def export_stats(output: Path) -> dict:
    stats = {"exists": output.is_dir(), "pages": 0, "images": 0, "other": 0, "bytes": 0}
    if not stats["exists"]:
        return stats
    for f in output.rglob("*"):
        if not f.is_file():
            continue
        stats["bytes"] += f.stat().st_size
        if f.suffix.lower() == ".md":
            stats["pages"] += 1
        elif f.suffix.lower() in IMAGE_EXTS:
            stats["images"] += 1
        else:
            stats["other"] += 1
    return stats


def confluence_check(base_url: str, email: str, token: str) -> dict:
    base_url = base_url.strip().rstrip("/")
    if not base_url.startswith("https://"):
        raise ValueError("Địa chỉ Confluence phải bắt đầu bằng https://")
    auth = base64.b64encode(f"{email.strip()}:{token.strip()}".encode()).decode()
    req = urllib.request.Request(
        base_url + "/wiki/rest/api/user/current",
        headers={"Authorization": f"Basic {auth}", "Accept": "application/json", "User-Agent": APP_NAME},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as err:
        if err.code in (401, 403):
            raise ValueError("Email hoặc API token không đúng.") from err
        if err.code == 404:
            raise ValueError("Không tìm thấy Confluence tại địa chỉ này. Kiểm tra lại địa chỉ.") from err
        raise ValueError(f"Confluence trả về lỗi {err.code}. Kiểm tra lại địa chỉ.") from err
    except urllib.error.URLError as err:
        raise ValueError(f"Không kết nối được tới {base_url}: {err.reason}") from err
    if data.get("type") == "anonymous" or not data.get("accountId"):
        raise ValueError("Email hoặc API token không đúng.")
    return {"name": data.get("displayName") or email, "email": data.get("email") or email}


def list_markdown(output: Path) -> list[str]:
    if not output.is_dir():
        return []
    return sorted(p.relative_to(output).as_posix() for p in output.rglob("*.md"))


def render_preview(output: Path, rel: str) -> str:
    import markdown

    md_path = safe_path(output, rel)
    body = markdown.markdown(
        md_path.read_text(encoding="utf-8", errors="replace"),
        extensions=["tables", "fenced_code", "sane_lists", "toc"],
    )
    base = md_path.parent.relative_to(output.resolve()).as_posix()

    def rewrite(match: re.Match) -> str:
        src = html.unescape(match.group(2))
        if urllib.parse.urlparse(src).scheme:
            return match.group(0)
        path = urllib.parse.unquote(src.split("?", 1)[0])
        joined = os.path.normpath(os.path.join(base, path)).replace("\\", "/")
        url = "/api/file?" + urllib.parse.urlencode({"output": str(output), "path": joined})
        return f'{match.group(1)}"{html.escape(url)}"'

    return re.sub(r'(<img[^>]*?\ssrc=)"([^"]*)"', rewrite, body)


# ---------------------------------------------------------------- github

def gh_api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict | list]:
    req = urllib.request.Request(
        "https://api.github.com" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": APP_NAME,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"message": raw.decode(errors="replace")}


def parse_repo(value: str) -> str:
    value = value.strip().removesuffix(".git").rstrip("/")
    match = re.search(r"(?:github\.com[/:])?([\w.-]+/[\w.-]+)$", value)
    if not match:
        raise ValueError("Repo phải có dạng owner/ten-repo hoặc link GitHub.")
    return match.group(1)


def github_check(repo: str, token: str) -> dict:
    status, data = gh_api("GET", f"/repos/{parse_repo(repo)}", token)
    if status != 200:
        raise ValueError(f"Không truy cập được repo ({status}): {data.get('message')}")
    return {"private": data["private"], "default_branch": data["default_branch"], "full_name": data["full_name"]}


def form_post(url: str, fields: dict) -> dict:
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(fields).encode(),
        headers={"Accept": "application/json", "User-Agent": APP_NAME},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def keyring_backend():
    """Trả về module keyring nếu máy có kho mật khẩu dùng được (Windows Credential Manager, macOS Keychain…)."""
    try:
        import keyring
        from keyring.backends import fail

        backend = keyring.get_keyring()
        if isinstance(backend, fail.Keyring) or getattr(backend, "priority", 0) <= 0:
            return None
        return keyring
    except Exception:  # noqa: BLE001 - thiếu backend thì coi như không hỗ trợ
        return None


class GitHubSession:
    """Giữ token GitHub trong bộ nhớ của tiến trình; trình duyệt không bao giờ thấy token."""

    lock = threading.Lock()
    token = ""
    user: dict = {}
    remembered = False
    device: dict = {}

    @classmethod
    def status(cls) -> dict:
        return {
            "logged_in": bool(cls.token), "login": cls.user.get("login", ""), "avatar": cls.user.get("avatar_url", ""),
            "name": cls.user.get("name") or "", "remembered": cls.remembered,
            "can_remember": keyring_backend() is not None, "device_enabled": bool(GITHUB_CLIENT_ID),
        }

    @classmethod
    def login(cls, token: str, remember: bool) -> dict:
        token = token.strip()
        status, user = gh_api("GET", "/user", token)
        if status != 200:
            raise ValueError("Token GitHub không hợp lệ hoặc đã hết hạn.")
        with cls.lock:
            cls.token, cls.user, cls.remembered = token, user, False
        kr = keyring_backend()
        if remember and kr:
            kr.set_password(APP_NAME, KEYRING_USER, token)
            cls.remembered = True
        return cls.status()

    @classmethod
    def logout(cls) -> None:
        with cls.lock:
            cls.token, cls.user, cls.remembered, cls.device = "", {}, False, {}
        kr = keyring_backend()
        if kr:
            try:
                kr.delete_password(APP_NAME, KEYRING_USER)
            except Exception:  # noqa: BLE001 - chưa lưu thì bỏ qua
                pass

    @classmethod
    def restore(cls) -> None:
        kr = keyring_backend()
        if not kr:
            return
        try:
            token = kr.get_password(APP_NAME, KEYRING_USER)
            if token:
                cls.login(token, remember=True)
        except Exception:  # noqa: BLE001 - token cũ không dùng được thì bắt đăng nhập lại
            pass

    @classmethod
    def require(cls) -> str:
        if not cls.token:
            raise ValueError("Bạn chưa đăng nhập GitHub.")
        return cls.token

    # -- Device Flow: https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
    @classmethod
    def device_start(cls, remember: bool) -> dict:
        if not GITHUB_CLIENT_ID:
            raise ValueError("Chưa cấu hình GitHub OAuth App cho tính năng đăng nhập.")
        try:
            data = form_post("https://github.com/login/device/code", {"client_id": GITHUB_CLIENT_ID, "scope": "repo"})
        except urllib.error.HTTPError as err:
            raise ValueError(f"GitHub từ chối yêu cầu đăng nhập ({err.code}). Kiểm tra Client ID của OAuth App.") from err
        if "device_code" not in data:
            raise ValueError(data.get("error_description") or "GitHub không cấp được mã đăng nhập.")
        state = {"state": "pending", "message": "", "id": secrets.token_hex(4)}
        cls.device = state
        threading.Thread(target=cls._device_poll, args=(data, remember, state), daemon=True).start()
        return {"user_code": data["user_code"], "verification_uri": data["verification_uri"],
                "expires_in": data["expires_in"]}

    @classmethod
    def _device_poll(cls, data: dict, remember: bool, state: dict) -> None:
        import time

        interval = int(data.get("interval", 5))
        deadline = time.time() + int(data.get("expires_in", 900))
        while time.time() < deadline and cls.device is state:
            time.sleep(interval)
            try:
                r = form_post("https://github.com/login/oauth/access_token", {
                    "client_id": GITHUB_CLIENT_ID, "device_code": data["device_code"],
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                })
            except (urllib.error.URLError, ValueError):
                continue
            if "access_token" in r:
                try:
                    cls.login(r["access_token"], remember)
                    state["state"] = "ok"
                except ValueError as exc:
                    state.update(state="error", message=str(exc))
                return
            err = r.get("error")
            if err == "slow_down":
                interval = int(r.get("interval", interval + 5))
            elif err != "authorization_pending":
                messages = {"access_denied": "Bạn đã từ chối cấp quyền.", "expired_token": "Mã đã hết hạn, hãy thử lại."}
                state.update(state="error", message=messages.get(err, r.get("error_description") or err))
                return
        if cls.device is state and state["state"] == "pending":
            state.update(state="error", message="Mã đã hết hạn, hãy thử lại.")


def list_repos(token: str) -> list[dict]:
    repos = []
    for page in range(1, 11):
        status, data = gh_api("GET", f"/user/repos?per_page=100&sort=updated&page={page}", token)
        if status != 200:
            raise ValueError(f"Không lấy được danh sách repo: {data.get('message')}")
        repos += [
            {"full_name": r["full_name"], "private": r["private"], "default_branch": r["default_branch"],
             "updated_at": r["updated_at"], "description": r.get("description") or ""}
            for r in data if r.get("permissions", {}).get("push") and not r.get("archived")
        ]
        if len(data) < 100:
            break
    return repos


def create_repo(token: str, name: str, private: bool) -> dict:
    name = name.strip()
    if not re.fullmatch(r"[\w.-]{1,100}", name):
        raise ValueError("Tên repo chỉ gồm chữ, số, dấu gạch ngang, gạch dưới hoặc dấu chấm.")
    status, data = gh_api("POST", "/user/repos", token, {
        "name": name, "private": private, "auto_init": True,
        "description": "Tài liệu export từ Confluence",
    })
    if status != 201:
        errors = "; ".join(e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict))
        raise ValueError(f"Không tạo được repo: {errors or data.get('message')}")
    return {"full_name": data["full_name"], "private": data["private"], "default_branch": data["default_branch"],
            "updated_at": data["updated_at"], "description": data.get("description") or ""}


MD_LINK = re.compile(r"!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")


def confluence_page_urls(output: Path) -> dict[str, str]:
    """Đọc confluence-lock.json (cme tạo khi export) → {đường dẫn .md: link trang Confluence gốc}."""
    try:
        lock = json.loads((output / "confluence-lock.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    urls = {}
    for base, org in (lock.get("orgs") or {}).items():
        for space, sp in (org.get("spaces") or {}).items():
            for page_id, page in (sp.get("pages") or {}).items():
                if page.get("export_path"):
                    urls[page["export_path"]] = f"{base.rstrip('/')}/wiki/spaces/{space}/pages/{page_id}"
    return urls


def format_size(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{n / 1024:.0f} KB"


def link_target(md_rel: str, href: str) -> str | None:
    """Đường dẫn (so với thư mục export) mà một link tương đối trong file .md trỏ tới; None nếu là link ngoài."""
    href = urllib.parse.unquote(href.split("?", 1)[0].split("#", 1)[0])
    if not href or urllib.parse.urlparse(href).scheme or href.startswith("/"):
        return None
    return os.path.normpath(os.path.join(os.path.dirname(md_rel), href)).replace("\\", "/")


def local_refs(output: Path, md_rel: str, text: str) -> set[str]:
    """Các file (ảnh, đính kèm) có thật trong thư mục export mà tài liệu này dùng tới."""
    refs = set()
    for href in [m.group(2) for m in MD_LINK.finditer(text)] + [m.group(1) for m in IMG_HTML.finditer(text)]:
        target = link_target(md_rel, html.unescape(href))
        if target and not target.startswith("..") and not target.endswith(".md") and (output / target).is_file():
            refs.add(target)
    return refs


META_FILE = ".cme-gui.json"
BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def load_meta(output: Path) -> dict:
    try:
        meta = json.loads((output / META_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        meta = {}
    meta.setdefault("renames", {})
    return meta


def save_meta(output: Path, meta: dict) -> None:
    (output / META_FILE).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def push_name(rel: str, renames: dict[str, str]) -> str:
    """Đường dẫn của tài liệu khi đưa lên GitHub (đã áp dụng tên mới nếu có)."""
    if rel in renames:
        return f"{os.path.dirname(rel)}/{renames[rel]}".lstrip("/")
    return rel


def list_documents(output: Path) -> list[dict]:
    renames = load_meta(output)["renames"]
    docs = []
    for rel in list_markdown(output):
        md = output / rel
        refs = local_refs(output, rel, md.read_text(encoding="utf-8", errors="replace"))
        size = md.stat().st_size + sum((output / r).stat().st_size for r in refs)
        docs.append({"path": rel, "name": renames.get(rel, os.path.basename(rel)), "renamed": rel in renames,
                     "assets": len(refs), "bytes": size})
    return docs


def rename_document(output: Path, rel: str, name: str) -> dict:
    safe_path(output, rel)
    if not (output / rel).is_file():
        raise ValueError("Không tìm thấy tài liệu.")
    name = name.strip()
    if name.lower().endswith(".md"):
        name = name[:-3].rstrip()
    if not name:
        raise ValueError("Tên tài liệu không được để trống.")
    if BAD_NAME.search(name) or name in (".", ".."):
        raise ValueError('Tên không được chứa các ký tự \\ / : * ? " < > |')
    name += ".md"
    meta = load_meta(output)
    renames = meta["renames"]
    if name == os.path.basename(rel):
        renames.pop(rel, None)
    else:
        folder = os.path.dirname(rel)
        taken = {push_name(r, renames).lower() for r in list_markdown(output) if r != rel}
        if push_name(f"{folder}/{name}".lstrip("/"), {}).lower() in taken:
            raise ValueError("Trong cùng thư mục đã có tài liệu mang tên này.")
        renames[rel] = name
    save_meta(output, meta)
    return {"path": rel, "name": name}


def delete_document(output: Path, rel: str) -> dict:
    md = safe_path(output, rel)
    if not md.is_file() or md.suffix.lower() != ".md":
        raise ValueError("Không tìm thấy tài liệu.")
    others = set()
    for other in list_markdown(output):
        if other != rel:
            others |= local_refs(output, other, (output / other).read_text(encoding="utf-8", errors="replace"))
    own = local_refs(output, rel, md.read_text(encoding="utf-8", errors="replace")) - others
    for r in own:
        (output / r).unlink(missing_ok=True)
    md.unlink()
    # Dọn các thư mục rỗng còn lại.
    for f in [md, *(output / r for r in own)]:
        parent = f.parent
        while parent != output.resolve() and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    meta = load_meta(output)
    if meta["renames"].pop(rel, None) is not None:
        save_meta(output, meta)
    return {"deleted": rel, "assets": len(own)}


def rewrite_for_push(text: str, md_rel: str, skipped: dict[str, int], page_urls: dict[str, str],
                     selected: set[str], renames: dict[str, str] | None = None) -> tuple[str, int, int]:
    """Sửa nội dung .md trước khi đẩy lên GitHub.

    - Link tới file bị bỏ qua (quá lớn) → dòng ghi chú dẫn về trang Confluence gốc.
    - Link tới tài liệu không được chọn → trỏ về trang Confluence của tài liệu đó (tránh link hỏng).
    """
    notes = relinks = 0
    page_url = page_urls.get(md_rel)

    def sub(match: re.Match) -> str:
        nonlocal notes, relinks
        target = link_target(md_rel, match.group(2))
        if target in skipped:
            notes += 1
            name = match.group(1).strip() or os.path.basename(target)
            where = f"[trang gốc trên Confluence]({page_url})" if page_url else "trang gốc trên Confluence"
            return (f"📎 *Tệp đính kèm **{name}** ({format_size(skipped[target])}) quá lớn nên không được đưa lên "
                    f"GitHub — xem tệp này tại {where}.*")
        if target and target.endswith(".md") and target not in selected and target in page_urls:
            relinks += 1
            return f"[{match.group(1)}]({page_urls[target]})"
        if target and renames and target in renames and target in selected:
            new = os.path.relpath(push_name(target, renames), os.path.dirname(md_rel) or ".").replace("\\", "/")
            return f"[{match.group(1)}]({urllib.parse.quote(new)})"
        return match.group(0)

    return MD_LINK.sub(sub, text), notes, relinks


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def run_push(job: Job, p: dict) -> bool:
    token, repo = GitHubSession.require(), parse_repo(p["repo"])
    branch = p.get("branch", "").strip() or "main"
    subdir = p.get("subdir", "").strip().strip("/")
    output = Path(p["output"]).expanduser()
    if not output.is_dir():
        raise ValueError(f"Không tìm thấy thư mục {output}")

    info = github_check(repo, token)
    if not info["private"] and not p.get("allow_public"):
        raise ValueError("Repo đang PUBLIC. Hãy chuyển sang private hoặc tick xác nhận đẩy lên repo public.")
    job.log(f"▶ Đẩy lên {info['full_name']} (nhánh {branch}, {'private' if info['private'] else 'PUBLIC'})")

    def api(method, path, body=None, ok=(200, 201)):
        status, data = gh_api(method, f"/repos/{repo}{path}", token, body)
        if status not in ok:
            raise ValueError(f"GitHub API {method} {path} lỗi {status}: {data.get('message')}")
        return data

    status, ref = gh_api("GET", f"/repos/{repo}/git/ref/heads/{branch}", token)
    if status == 409:  # repo rỗng: Git Data API cần ít nhất 1 commit
        job.log("  Repo đang trống → tạo commit khởi tạo README.md")
        api("PUT", "/contents/README.md", {
            "message": "Initial commit", "branch": branch,
            "content": base64.b64encode(b"# Confluence export\n").decode(),
        })
        status, ref = gh_api("GET", f"/repos/{repo}/git/ref/heads/{branch}", token)
    branch_exists = status == 200
    if branch_exists:
        parent = ref["object"]["sha"]
    else:
        job.log(f"  Nhánh {branch} chưa có → tạo từ {info['default_branch']}")
        parent = api("GET", f"/git/ref/heads/{info['default_branch']}")["object"]["sha"]
    base_tree = api("GET", f"/git/commits/{parent}")["tree"]["sha"]
    remote_tree = api("GET", f"/git/trees/{base_tree}?recursive=1")
    remote = {} if remote_tree.get("truncated") else {
        e["path"]: e["sha"] for e in remote_tree["tree"] if e["type"] == "blob"
    }

    all_docs = list_markdown(output)
    selected = set(all_docs) if p.get("docs") is None else set(p["docs"]) & set(all_docs)
    if not selected:
        raise ValueError("Chưa chọn tài liệu nào để push.")
    wanted = set(selected)
    for rel in selected:
        wanted |= local_refs(output, rel, (output / rel).read_text(encoding="utf-8", errors="replace"))
    # File .md xử lý sau cùng để biết hết file nào bị bỏ qua mà sửa link trong đó.
    files = sorted((output / rel for rel in wanted), key=lambda f: (f.suffix.lower() == ".md", str(f)))
    skipped: dict[str, int] = {}
    page_urls = confluence_page_urls(output)
    renames = load_meta(output)["renames"]
    entries, notes, relinks = [], 0, 0
    job.log(f"  {len(selected)}/{len(all_docs)} tài liệu được chọn · {len(files)} file (kèm ảnh, đính kèm)")
    for i, f in enumerate(files, 1):
        if job.cancelled:
            job.log("⏹ Đã dừng.")
            return False
        rel = f.relative_to(output).as_posix()
        path = f"{subdir}/{push_name(rel, renames)}" if subdir else push_name(rel, renames)
        size = f.stat().st_size
        if size > GITHUB_MAX_FILE:
            skipped[rel] = size
            continue
        data = f.read_bytes()
        if f.suffix.lower() == ".md":
            original = data.decode("utf-8", errors="replace")
            text, n, r = rewrite_for_push(original, rel, skipped, page_urls, selected, renames)
            if text != original:
                data, notes, relinks = text.encode("utf-8"), notes + n, relinks + r
        if remote.get(path) == git_blob_sha(data):
            continue
        status, blob = gh_api("POST", f"/repos/{repo}/git/blobs", token,
                              {"content": base64.b64encode(data).decode(), "encoding": "base64"})
        if status == 422 and "too large" in str(blob.get("message", "")):
            skipped[rel] = size
            continue
        if status != 201:
            raise ValueError(f"GitHub API POST /git/blobs lỗi {status}: {blob.get('message')}")
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        if len(entries) % 20 == 0:
            job.log(f"  Đã tải lên {len(entries)} file thay đổi ({i}/{len(files)})")

    skipped_big = list(skipped)
    if renames.keys() & selected:
        job.log(f"  ✏ {len(renames.keys() & selected)} tài liệu được đổi tên khi đưa lên GitHub")
    for rel in skipped_big:
        job.log(f"  ⚠ Bỏ qua {rel} ({format_size(skipped[rel])}): quá lớn để tải lên GitHub (giới hạn ~40MB)")
    if notes:
        job.log(f"  📎 Đã thay {notes} link tới file bị bỏ qua bằng ghi chú dẫn về trang Confluence gốc")
    if relinks:
        job.log(f"  🔗 {relinks} link tới tài liệu không được chọn đã trỏ về trang Confluence gốc")
    if not entries:
        job.result = {"url": f"https://github.com/{repo}/tree/{branch}/{subdir}".rstrip("/"), "files": 0, "skipped": skipped_big}
        job.log("✅ Không có thay đổi nào so với GitHub.")
        return True

    tree = base_tree
    for start in range(0, len(entries), 500):
        tree = api("POST", "/git/trees", {"base_tree": tree, "tree": entries[start:start + 500]})["sha"]
    message = p.get("message", "").strip() or "Cập nhật tài liệu từ Confluence"
    commit = api("POST", "/git/commits", {"message": message, "tree": tree, "parents": [parent]})["sha"]
    if branch_exists:
        api("PATCH", f"/git/refs/heads/{branch}", {"sha": commit})
    else:
        api("POST", "/git/refs", {"ref": f"refs/heads/{branch}", "sha": commit})
    url = f"https://github.com/{repo}/tree/{branch}/{subdir}".rstrip("/")
    job.result = {"url": url, "files": len(entries), "skipped": skipped_big}
    job.log(f"✅ Đã push {len(entries)} file. Xem tại: {url}")
    return True


# ---------------------------------------------------------------- http server

class Handler(BaseHTTPRequestHandler):
    server_version = APP_NAME

    def log_message(self, fmt, *args):  # giữ console gọn
        pass

    def _authorized(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        return "session" in cookie and secrets.compare_digest(cookie["session"].value, SESSION)

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _error(self, msg: str, status: int = 400) -> None:
        self._json({"error": msg}, status)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path in ("/", "/index.html"):
            page = (STATIC_DIR / "index.html").read_bytes()
            cookie = f"session={SESSION}; Path=/; HttpOnly; SameSite=Strict"
            # Phần xem trước chèn HTML từ Confluence: CSP chặn mọi script lạ trong đó.
            csp = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                   "img-src 'self' https: data:; font-src 'self'")
            return self._send(200, page, "text/html; charset=utf-8",
                              {"Set-Cookie": cookie, "Content-Security-Policy": csp})
        if url.path.startswith("/static/"):
            try:
                f = safe_path(STATIC_DIR, url.path.removeprefix("/static/"))
                ctype = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                         ".woff2": "font/woff2", ".svg": "image/svg+xml"}.get(f.suffix, "application/octet-stream")
                return self._send(200, f.read_bytes(), ctype)
            except (ValueError, OSError):
                return self._error("Không tìm thấy", 404)
        if not self._authorized():
            return self._error("Phiên không hợp lệ, hãy tải lại trang.", 403)
        try:
            if url.path == "/api/settings":
                from confluence_md_gui import __version__

                return self._json({**load_settings(), "version": __version__})
            if url.path == "/api/gh/status":
                return self._json(GitHubSession.status())
            if url.path == "/api/gh/device":
                return self._json({k: v for k, v in GitHubSession.device.items() if k != "id"} or {"state": "idle"})
            if url.path == "/api/gh/repos":
                return self._json({"repos": list_repos(GitHubSession.require())})
            if url.path == "/api/stats":
                return self._json(export_stats(Path(q["output"]).expanduser()))
            if url.path == "/api/job":
                job = Job.current
                if not job:
                    return self._json({"running": False, "lines": [], "total": 0})
                since = int(q.get("since", 0))
                return self._json({"kind": job.kind, "running": job.running, "ok": job.ok, "result": job.result,
                                   "lines": job.lines[since:], "total": len(job.lines)})
            if url.path == "/api/docs":
                return self._json({"docs": list_documents(Path(q["output"]).expanduser())})
            if url.path == "/api/tree":
                return self._json({"files": list_markdown(Path(q["output"]).expanduser())})
            if url.path == "/api/preview":
                return self._json({"html": render_preview(Path(q["output"]).expanduser(), q["path"])})
            if url.path == "/api/file":
                f = safe_path(Path(q["output"]).expanduser(), q["path"])
                ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
                         ".svg": "image/svg+xml", ".webp": "image/webp"}.get(f.suffix.lower(), "application/octet-stream")
                return self._send(200, f.read_bytes(), ctype)
        except (ValueError, OSError, KeyError) as exc:
            return self._error(str(exc))
        self._error("Không tìm thấy", 404)

    def do_POST(self):
        if not self._authorized():
            return self._error("Phiên không hợp lệ, hãy tải lại trang.", 403)
        path = urllib.parse.urlparse(self.path).path
        try:
            p = self._body()
            if path == "/api/export":
                for key in ("base_url", "email", "token", "target_url", "output"):
                    if not str(p.get(key, "")).strip():
                        raise ValueError(f"Thiếu thông tin: {key}")
                if p.get("mode") not in EXPORT_MODES:
                    raise ValueError("Kiểu export không hợp lệ.")
                save_settings(p)
                Job.start("export", run_export, p)
                return self._json({"started": True})
            if path == "/api/push":
                GitHubSession.require()
                for key in ("repo", "output"):
                    if not str(p.get(key, "")).strip():
                        raise ValueError(f"Thiếu thông tin: {key}")
                save_settings(p)
                Job.start("push", run_push, p)
                return self._json({"started": True})
            if path == "/api/cancel":
                job = Job.current
                if job and job.running:
                    job.cancelled = True
                    if job.proc and job.proc.poll() is None:
                        job.proc.terminate()
                return self._json({"ok": True})
            if path == "/api/doc/rename":
                return self._json(rename_document(Path(p["output"]).expanduser(), p["path"], p["name"]))
            if path == "/api/doc/delete":
                if Job.current and Job.current.running:
                    raise ValueError("Đang có tác vụ chạy, vui lòng đợi xong rồi xoá.")
                return self._json(delete_document(Path(p["output"]).expanduser(), p["path"]))
            if path == "/api/check-links":
                return self._json(check_links(Path(p["output"]).expanduser(), bool(p.get("strip_query"))))
            if path == "/api/confluence-check":
                save_settings(p)
                return self._json(confluence_check(p["base_url"], p["email"], p["token"]))
            if path == "/api/github-check":
                return self._json(github_check(p["repo"], GitHubSession.require()))
            if path == "/api/gh/token":
                return self._json(GitHubSession.login(p["token"], bool(p.get("remember"))))
            if path == "/api/gh/device":
                return self._json(GitHubSession.device_start(bool(p.get("remember"))))
            if path == "/api/gh/logout":
                GitHubSession.logout()
                return self._json(GitHubSession.status())
            if path == "/api/gh/create-repo":
                return self._json(create_repo(GitHubSession.require(), p["name"], bool(p.get("private", True))))
        except (ValueError, OSError, KeyError) as exc:
            return self._error(str(exc))
        self._error("Không tìm thấy", 404)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(port: int, open_browser: bool) -> None:
    port = port or free_port()
    GitHubSession.restore()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"Confluence → Markdown đang chạy tại {url}")
    print("Đóng cửa sổ này (hoặc Ctrl+C) để thoát.")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "cme":
        from confluence_markdown_exporter.main import app

        sys.argv = ["cme", *sys.argv[2:]]
        app()
        return
    from confluence_md_gui import __version__

    parser = argparse.ArgumentParser(prog="cme-gui", description="Giao diện web export Confluence → Markdown → GitHub.")
    parser.add_argument("--port", type=int, default=0, help="cổng chạy (mặc định: chọn ngẫu nhiên)")
    parser.add_argument("--no-browser", action="store_true", help="không tự mở trình duyệt")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = parser.parse_args()
    serve(args.port, not args.no_browser)


if __name__ == "__main__":
    main()
