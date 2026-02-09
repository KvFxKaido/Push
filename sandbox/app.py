"""
Modal Python App — Sandbox CRUD for Push.

Exposes sandbox web endpoints as plain HTTPS POST routes.
Each endpoint receives JSON and returns JSON.
Browser never talks to this directly — Cloudflare Worker proxies all calls.

Deploy: cd sandbox && python -m modal deploy app.py
"""

import modal
import base64
import json
import hmac
import secrets
import urllib.request
import urllib.parse
import urllib.error
import ipaddress
import socket
from playwright.sync_api import sync_playwright

app = modal.App("push-sandbox")

# Image for sandbox containers (cloned repos run here)
sandbox_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl")
    .pip_install("ruff", "pytest")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        # Default git identity — overridden per-session when GitHub token is available
        "git config --global user.email 'sandbox@diff.app'",
        "git config --global user.name 'Push User'",
    )
)

# Image for the web endpoint functions themselves (needs FastAPI + remote browser control)
endpoint_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]", "playwright")
OWNER_TOKEN_FILE = "/tmp/push-owner-token"
MAX_SCREENSHOT_BYTES = 1_500_000
MAX_EXTRACT_CHARS = 20_000
ALLOWED_DOMAINS: set[str] = {"push.ishawnd.workers.dev"}
LIST_DIR_SCRIPT = """
import json
import os
import sys

target = sys.argv[1]

try:
    entries = []
    with os.scandir(target) as it:
        for entry in it:
            if entry.name in (".", ".."):
                continue

            try:
                if entry.is_dir(follow_symlinks=False):
                    entries.append({"name": entry.name, "type": "directory", "size": 0})
                elif entry.is_file(follow_symlinks=False):
                    size = 0
                    try:
                        size = entry.stat(follow_symlinks=False).st_size
                    except Exception:
                        size = 0
                    entries.append({"name": entry.name, "type": "file", "size": size})
            except Exception:
                continue

    entries.sort(key=lambda e: (0 if e["type"] == "directory" else 1, e["name"].lower()))
    print(json.dumps({"ok": True, "entries": entries}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
"""


def _fetch_github_user(token: str) -> tuple[str, str]:
    """Fetch name and email from GitHub API. Returns (name, email) or defaults."""
    try:
        req = urllib.request.Request(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            user = json.loads(resp.read())
        name = user.get("name") or user.get("login", "Push User")
        login = user.get("login", "user")
        email = user.get("email") or f"{login}@users.noreply.github.com"
        return name, email
    except Exception:
        return "Push User", "sandbox@push.app"


def _issue_owner_token(sb: modal.Sandbox) -> str | None:
    token = secrets.token_urlsafe(32)
    p = sb.exec(
        "python3",
        "-c",
        (
            "import pathlib,sys;"
            f"p=pathlib.Path('{OWNER_TOKEN_FILE}');"
            "p.write_text(sys.argv[1], encoding='utf-8');"
            "p.chmod(0o600)"
        ),
        token,
    )
    p.wait()
    if p.returncode != 0:
        return None
    return token


def _validate_owner_token(sb: modal.Sandbox, provided_token: str) -> bool:
    if not provided_token:
        return False
    p = sb.exec(
        "python3",
        "-c",
        (
            "import pathlib;"
            f"p=pathlib.Path('{OWNER_TOKEN_FILE}');"
            "print(p.read_text(encoding='utf-8') if p.exists() else '')"
        ),
    )
    p.wait()
    if p.returncode != 0:
        return False
    expected = p.stdout.read().strip()
    return bool(expected) and hmac.compare_digest(expected, str(provided_token))


def _is_blocked_browser_target(url: str) -> tuple[bool, str]:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return True, "Invalid URL"

    if parsed.scheme not in ("http", "https"):
        return True, "Only http(s) URLs are allowed"

    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        return True, "URL hostname is required"
    if hostname in ALLOWED_DOMAINS:
        return False, ""

    if hostname in ("localhost", "127.0.0.1", "::1") or hostname.endswith(".local"):
        return True, "Localhost targets are not allowed"

    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return True, "Private/local network targets are not allowed"
    except ValueError:
        # Hostname: resolve and block if it resolves to private/local addresses.
        try:
            infos = socket.getaddrinfo(hostname, None)
            for info in infos:
                candidate = info[4][0]
                resolved = ipaddress.ip_address(candidate)
                if (
                    resolved.is_private
                    or resolved.is_loopback
                    or resolved.is_link_local
                    or resolved.is_multicast
                    or resolved.is_reserved
                    or resolved.is_unspecified
                ):
                    return True, "Target resolves to a private/local network address"
        except Exception:
            # DNS failures are treated as invalid targets.
            return True, "Unable to resolve hostname"

    return False, ""


def _browserbase_create_session(api_key: str, project_id: str) -> dict:
    payload = json.dumps({"projectId": project_id}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.browserbase.com/v1/sessions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-BB-API-Key": api_key,
        },
        data=payload,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
    return json.loads(raw)


def _browserbase_end_session(api_key: str, session_id: str) -> None:
    if not session_id:
        return
    req = urllib.request.Request(
        f"https://api.browserbase.com/v1/sessions/{urllib.parse.quote(session_id)}",
        method="DELETE",
        headers={"X-BB-API-Key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception:
        # Best-effort cleanup only.
        return


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def create(data: dict):
    """Clone repo into a new sandbox, return sandbox_id."""
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=sandbox_image,
        timeout=1800,
    )

    github_token = data.get("github_token", "")
    repo = data.get("repo", "")
    branch = data.get("branch", "main")

    if not repo:
        sb.terminate()
        return {"error": "Missing repo", "sandbox_id": None}

    if github_token:
        clone_url = f"https://x-access-token:{github_token}@github.com/{repo}.git"
    else:
        clone_url = f"https://github.com/{repo}.git"

    p = sb.exec("git", "clone", "--depth=50", "--branch", branch, clone_url, "/workspace")
    p.wait()

    if p.returncode != 0:
        stderr = p.stderr.read()
        sb.terminate()
        return {"error": f"Clone failed: {stderr}", "sandbox_id": None}

    # Configure git identity so commits work inside the sandbox
    if github_token:
        name, email = _fetch_github_user(github_token)
    else:
        name, email = "Push User", "sandbox@push.app"
    sb.exec("git", "config", "--global", "user.name", name).wait()
    sb.exec("git", "config", "--global", "user.email", email).wait()

    owner_token = _issue_owner_token(sb)
    if not owner_token:
        sb.terminate()
        return {"error": "Failed to initialize sandbox access token", "sandbox_id": None}

    return {"sandbox_id": sb.object_id, "owner_token": owner_token, "status": "ready"}


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def exec_command(data: dict):
    """Run a command in an existing sandbox."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    command = data.get("command", "")
    workdir = data.get("workdir", "/workspace")

    if not sandbox_id or not command:
        return {"error": "Missing sandbox_id or command", "exit_code": -1}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        return {"error": "Unauthorized sandbox access", "exit_code": -1}
    p = sb.exec("bash", "-c", f"cd {workdir} && {command}")
    p.wait()

    stdout = p.stdout.read()
    stderr = p.stderr.read()

    return {
        "stdout": stdout[:10_000],
        "stderr": stderr[:5_000],
        "exit_code": p.returncode,
        "truncated": len(stdout) > 10_000 or len(stderr) > 5_000,
    }


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def file_ops(data: dict):
    """Handle sandbox file operations through one endpoint (read/write/list/delete)."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    action = data.get("action", "")
    path = data.get("path", "")

    if not sandbox_id:
        return {"error": "Missing sandbox_id"}
    if action not in ("read", "write", "list", "delete"):
        return {"error": f"Unknown file operation: {action}"}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        if action in ("write", "delete"):
            return {"ok": False, "error": "Unauthorized sandbox access"}
        if action == "read":
            return {"error": "Unauthorized sandbox access", "content": ""}
        return {"error": "Unauthorized sandbox access", "entries": []}

    if action == "read":
        if not path:
            return {"error": "Missing sandbox_id or path"}
        p = sb.exec("cat", path)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"error": f"Read failed: {stderr}", "content": ""}

        content = p.stdout.read()
        return {"content": content[:50_000], "truncated": len(content) > 50_000}

    if action == "write":
        content = str(data.get("content", ""))
        if not path:
            return {"ok": False, "error": "Missing sandbox_id or path"}

        safe_path = path.replace("'", "'\\''")

        p = sb.exec("bash", "-c", f"mkdir -p \"$(dirname '{safe_path}')\"")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Failed to create directory: {stderr}"}

        encoded = base64.b64encode(content.encode()).decode()
        p = sb.exec(
            "bash",
            "-c",
            f"printf '%s' '{encoded}' | base64 -d > '{safe_path}'",
        )
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Write failed: {stderr}"}

        p = sb.exec("bash", "-c", f"wc -c < '{safe_path}'")
        p.wait()
        if p.returncode != 0:
            return {"ok": False, "error": "Verification failed — file may not have been written"}

        written_bytes = p.stdout.read().strip()
        return {
            "ok": True,
            "bytes_written": int(written_bytes) if written_bytes.isdigit() else 0,
        }

    if action == "list":
        target = path or "/workspace"
        p = sb.exec("python3", "-c", LIST_DIR_SCRIPT, target)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"error": f"List failed: {stderr}", "entries": []}

        stdout = p.stdout.read().strip()
        if not stdout:
            return {"entries": []}

        try:
            parsed = json.loads(stdout)
        except Exception:
            return {"error": "List failed: invalid response from sandbox", "entries": []}

        if not parsed.get("ok"):
            return {"error": f"List failed: {parsed.get('error', 'Unknown error')}", "entries": []}

        base = target.rstrip("/") or "/"
        entries = []
        for item in parsed.get("entries", []):
            name = item.get("name", "")
            if not name:
                continue
            entry_path = f"/{name}" if base == "/" else f"{base}/{name}"
            entries.append({
                "name": name,
                "path": entry_path,
                "type": "directory" if item.get("type") == "directory" else "file",
                "size": int(item.get("size", 0) or 0),
            })

        return {"entries": entries}

    # action == "delete"
    if not path:
        return {"ok": False, "error": "Missing sandbox_id or path"}
    if path in ("/", "/workspace", "/workspace/"):
        return {"ok": False, "error": "Cannot delete workspace root"}

    p = sb.exec("rm", "-rf", path)
    p.wait()
    return {"ok": p.returncode == 0}


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def get_diff(data: dict):
    """Get git diff of all changes."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")

    if not sandbox_id:
        return {"error": "Missing sandbox_id", "diff": ""}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        return {"error": "Unauthorized sandbox access", "diff": ""}

    # Step 1: Clear stale index lock (left by crashed git operations)
    sb.exec("bash", "-c", "rm -f /workspace/.git/index.lock").wait()

    # Step 2: Check git status first to diagnose "no changes" issues
    p = sb.exec("bash", "-c", "cd /workspace && git status --porcelain")
    p.wait()
    status_output = p.stdout.read().strip()
    status_stderr = p.stderr.read().strip()

    if status_stderr:
        return {"error": f"git status failed: {status_stderr}", "diff": ""}

    if not status_output:
        # No changes detected by git — return empty diff with diagnostic info
        return {"diff": "", "truncated": False, "git_status": "clean"}

    # Step 3: Stage all changes
    p = sb.exec("bash", "-c", "cd /workspace && git add -A")
    p.wait()
    if p.returncode != 0:
        stderr = p.stderr.read()
        return {"error": f"git add failed: {stderr}", "diff": ""}

    # Step 4: Get the diff of staged changes
    p = sb.exec("bash", "-c", "cd /workspace && git diff --cached")
    p.wait()

    diff = p.stdout.read()
    return {
        "diff": diff[:20_000],
        "truncated": len(diff) > 20_000,
        "git_status": status_output[:2_000],
    }


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def browser_screenshot(data: dict):
    """Browser screenshot endpoint (Browserbase-backed; wiring scaffold)."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    url = str(data.get("url", "")).strip()

    if not sandbox_id or not url:
        return {"ok": False, "error": "Missing sandbox_id or url"}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        return {"ok": False, "error": "Unauthorized sandbox access"}

    browserbase_api_key = str(data.get("browserbase_api_key", "")).strip()
    browserbase_project_id = str(data.get("browserbase_project_id", "")).strip()
    if not browserbase_api_key or not browserbase_project_id:
        return {
            "ok": False,
            "error": "BROWSERBASE_NOT_CONFIGURED",
            "details": "Missing Browserbase credentials. Configure BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID on the Worker.",
        }

    blocked, blocked_reason = _is_blocked_browser_target(url)
    if blocked:
        return {
            "ok": False,
            "error": "INVALID_URL",
            "details": blocked_reason,
        }

    full_page = bool(data.get("full_page", False))
    session_id = ""

    try:
        session = _browserbase_create_session(browserbase_api_key, browserbase_project_id)
        session_id = str(session.get("id", ""))
        connect_url = str(session.get("connectUrl") or session.get("connect_url") or "").strip()
        if not connect_url:
            return {
                "ok": False,
                "error": "BROWSER_CONNECT_URL_MISSING",
                "details": "Browserbase session was created without a connect URL.",
            }

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(connect_url, timeout=20000)

            if browser.contexts:
                context = browser.contexts[0]
                if context.pages:
                    page = context.pages[0]
                else:
                    page = context.new_page()
            else:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                page = context.new_page()

            page.set_default_timeout(15000)
            response = page.goto(url, wait_until="domcontentloaded", timeout=15000)
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                # networkidle can time out on long-polling pages; keep screenshot flow moving.
                pass

            status_code = response.status if response else None
            final_url = page.url
            title = page.title() or ""

            image_bytes = page.screenshot(full_page=full_page, type="png")
            mime_type = "image/png"
            truncated = False

            if len(image_bytes) > MAX_SCREENSHOT_BYTES:
                # Fallback for mobile payload safety.
                image_bytes = page.screenshot(full_page=False, type="jpeg", quality=60)
                mime_type = "image/jpeg"
                truncated = True

            browser.close()

        if len(image_bytes) > MAX_SCREENSHOT_BYTES:
            return {
                "ok": False,
                "error": "IMAGE_TOO_LARGE",
                "details": f"Screenshot exceeded {MAX_SCREENSHOT_BYTES} bytes after compression.",
            }

        image_b64 = base64.b64encode(image_bytes).decode("ascii")
        return {
            "ok": True,
            "title": title,
            "final_url": final_url,
            "status_code": status_code,
            "mime_type": mime_type,
            "image_base64": image_b64,
            "truncated": truncated,
        }
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body = str(exc)
        return {
            "ok": False,
            "error": "BROWSERBASE_HTTP_ERROR",
            "details": f"{exc.code}: {body[:300]}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": "BROWSERBASE_EXECUTION_ERROR",
            "details": str(exc),
        }
    finally:
        _browserbase_end_session(browserbase_api_key, session_id)


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def browser_extract(data: dict):
    """Browser extract endpoint (Browserbase-backed text extraction)."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    url = str(data.get("url", "")).strip()
    instruction = str(data.get("instruction", "")).strip()

    if not sandbox_id or not url:
        return {"ok": False, "error": "Missing sandbox_id or url"}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        return {"ok": False, "error": "Unauthorized sandbox access"}

    browserbase_api_key = str(data.get("browserbase_api_key", "")).strip()
    browserbase_project_id = str(data.get("browserbase_project_id", "")).strip()
    if not browserbase_api_key or not browserbase_project_id:
        return {
            "ok": False,
            "error": "BROWSERBASE_NOT_CONFIGURED",
            "details": "Missing Browserbase credentials. Configure BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID on the Worker.",
        }

    blocked, blocked_reason = _is_blocked_browser_target(url)
    if blocked:
        return {
            "ok": False,
            "error": "INVALID_URL",
            "details": blocked_reason,
        }

    session_id = ""
    try:
        session = _browserbase_create_session(browserbase_api_key, browserbase_project_id)
        session_id = str(session.get("id", ""))
        connect_url = str(session.get("connectUrl") or session.get("connect_url") or "").strip()
        if not connect_url:
            return {
                "ok": False,
                "error": "BROWSER_CONNECT_URL_MISSING",
                "details": "Browserbase session was created without a connect URL.",
            }

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(connect_url, timeout=20000)

            if browser.contexts:
                context = browser.contexts[0]
                if context.pages:
                    page = context.pages[0]
                else:
                    page = context.new_page()
            else:
                context = browser.new_context(viewport={"width": 1280, "height": 720})
                page = context.new_page()

            page.set_default_timeout(15000)
            response = page.goto(url, wait_until="domcontentloaded", timeout=15000)
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass

            status_code = response.status if response else None
            final_url = page.url
            title = page.title() or ""

            # Base extraction: readable text from the page body.
            extracted = page.locator("body").inner_text(timeout=5000)

            # Optional focused extraction when instruction includes selector hints.
            # Supported hints:
            # - "selector: .foo"
            # - "css: .foo"
            selector = ""
            lowered = instruction.lower()
            for prefix in ("selector:", "css:"):
                if lowered.startswith(prefix):
                    selector = instruction[len(prefix):].strip()
                    break

            if selector:
                try:
                    extracted = page.locator(selector).first.inner_text(timeout=5000)
                except Exception:
                    # Keep base extraction if selector resolution fails.
                    pass

            browser.close()

        normalized = " ".join((extracted or "").split())
        if not normalized:
            return {
                "ok": False,
                "error": "EMPTY_EXTRACTION",
                "details": "No readable text found on the page.",
            }

        truncated = len(normalized) > MAX_EXTRACT_CHARS
        content = normalized[:MAX_EXTRACT_CHARS]
        return {
            "ok": True,
            "title": title,
            "final_url": final_url,
            "status_code": status_code,
            "content": content,
            "truncated": truncated,
        }
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body = str(exc)
        return {
            "ok": False,
            "error": "BROWSERBASE_HTTP_ERROR",
            "details": f"{exc.code}: {body[:300]}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": "BROWSERBASE_EXECUTION_ERROR",
            "details": str(exc),
        }
    finally:
        _browserbase_end_session(browserbase_api_key, session_id)


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def cleanup(data: dict):
    """Terminate a sandbox."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")

    if not sandbox_id:
        return {"ok": False, "error": "Missing sandbox_id"}

    sb = modal.Sandbox.from_id(sandbox_id)
    if not _validate_owner_token(sb, owner_token):
        return {"ok": False, "error": "Unauthorized sandbox access"}
    sb.terminate()
    return {"ok": True}
