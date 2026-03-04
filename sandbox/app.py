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
import os
import urllib.request
import urllib.parse
import urllib.error
import ipaddress
import socket

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
MAX_ARCHIVE_BYTES = 100_000_000
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

FILE_VERSION_SCRIPT = """
import hashlib
import pathlib
import sys

target = pathlib.Path(sys.argv[1])

if not target.exists() or not target.is_file():
    print("")
    sys.exit(0)

try:
    payload = target.read_bytes()
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)

print(hashlib.sha256(payload).hexdigest())
"""

# Consolidated write script — does version check + mkdir + write + verify + hash
# in a single subprocess call instead of 5 separate exec() calls.
# Accepts a JSON argument: { path, content_b64, expected_version? }
# Outputs a JSON result: { ok, bytes_written?, new_version?, code?, expected_version?, current_version?, error? }
WRITE_FILE_SCRIPT = """
import hashlib, pathlib, base64, json, os, sys

try:
    data = json.loads(sys.argv[1])
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Invalid JSON argument: {exc}"}))
    sys.exit(0)

path_str = data.get("path", "")
content_b64 = data.get("content_b64", "")
expected_version = data.get("expected_version", "")

if not path_str:
    print(json.dumps({"ok": False, "error": "Missing path"}))
    sys.exit(0)

# Normalize relative paths to /workspace
if not os.path.isabs(path_str):
    path_str = os.path.join("/workspace", path_str)

p = pathlib.Path(path_str)

# Step 1: Version check (if expected_version provided)
if expected_version:
    if p.exists() and p.is_file():
        try:
            current = hashlib.sha256(p.read_bytes()).hexdigest()
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"Version check failed: {exc}"}))
            sys.exit(0)
        if current != expected_version:
            print(json.dumps({
                "ok": False,
                "code": "STALE_FILE",
                "error": "Stale file version. Re-read the file before writing.",
                "expected_version": expected_version,
                "current_version": current,
            }))
            sys.exit(0)

# Step 2: Create parent directory
try:
    parent = os.path.dirname(path_str)
    if parent:
        os.makedirs(parent, exist_ok=True)
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Failed to create directory: {exc}"}))
    sys.exit(0)

# Step 3: Write content
try:
    content = base64.b64decode(content_b64)
    p.write_bytes(content)
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Write failed: {exc}"}))
    sys.exit(0)

# Step 4+5: Verify size + compute new version
try:
    actual_size = p.stat().st_size
    new_version = hashlib.sha256(p.read_bytes()).hexdigest()
    print(json.dumps({"ok": True, "bytes_written": actual_size, "new_version": new_version}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Verification failed: {exc}"}))
"""

# Batch write script — writes multiple files in a single subprocess call.
# Accepts a JSON argument: { files: [{ path, content_b64, expected_version? }] }
# Outputs a JSON result: { results: [{ ok, path, bytes_written?, new_version?, ... }] }
BATCH_WRITE_SCRIPT = """
import hashlib, pathlib, base64, json, os, sys

try:
    data = json.loads(sys.argv[1])
except Exception as exc:
    print(json.dumps({"results": [{"ok": False, "error": f"Invalid JSON argument: {exc}"}]}))
    sys.exit(0)

files = data.get("files", [])
results = []

for f in files:
    path_str = f.get("path", "")
    content_b64 = f.get("content_b64", "")
    expected_version = f.get("expected_version", "")

    if not path_str:
        results.append({"ok": False, "path": path_str, "error": "Missing path"})
        continue

    # Normalize relative paths to /workspace
    if not os.path.isabs(path_str):
        path_str = os.path.join("/workspace", path_str)

    p = pathlib.Path(path_str)

    # Version check
    if expected_version:
        if p.exists() and p.is_file():
            try:
                current = hashlib.sha256(p.read_bytes()).hexdigest()
            except Exception as exc:
                results.append({"ok": False, "path": path_str, "error": f"Version check failed: {exc}"})
                continue
            if current != expected_version:
                results.append({
                    "ok": False, "path": path_str, "code": "STALE_FILE",
                    "error": "Stale file version.",
                    "expected_version": expected_version, "current_version": current,
                })
                continue

    # Create parent directory
    try:
        parent = os.path.dirname(path_str)
        if parent:
            os.makedirs(parent, exist_ok=True)
    except Exception as exc:
        results.append({"ok": False, "path": path_str, "error": f"Failed to create directory: {exc}"})
        continue

    # Write content
    try:
        content = base64.b64decode(content_b64)
        p.write_bytes(content)
    except Exception as exc:
        results.append({"ok": False, "path": path_str, "error": f"Write failed: {exc}"})
        continue

    # Verify + new version
    try:
        actual_size = p.stat().st_size
        new_version = hashlib.sha256(p.read_bytes()).hexdigest()
        results.append({"ok": True, "path": path_str, "bytes_written": actual_size, "new_version": new_version})
    except Exception as exc:
        results.append({"ok": False, "path": path_str, "error": f"Verification failed: {exc}"})

print(json.dumps({"results": results}))
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


def _parse_commit_identity(value: object) -> tuple[str, str] | None:
    if not isinstance(value, dict):
        return None
    name = value.get("name")
    email = value.get("email")
    if not isinstance(name, str) or not isinstance(email, str):
        return None
    name = name.strip()
    email = email.strip()
    if not name or not email:
        return None
    if len(name) > 200 or len(email) > 320:
        return None
    return name, email


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
    try:
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
    except Exception:
        # Sandbox may no longer exist / be reachable.
        return False


def _format_sandbox_lookup_error(exc: Exception) -> str:
    detail = str(exc).strip()
    lowered = detail.lower()
    if "not found" in lowered or "does not exist" in lowered or "no such" in lowered:
        return "Sandbox not found or expired. Start a new sandbox session."
    if "terminated" in lowered or "closed" in lowered:
        return "Sandbox is no longer running. Start a new sandbox session."
    if detail:
        return f"Sandbox unavailable: {detail}"
    return "Sandbox unavailable. Start a new sandbox session."


def _load_sandbox(sandbox_id: str) -> tuple[modal.Sandbox | None, str | None]:
    try:
        return modal.Sandbox.from_id(sandbox_id), None
    except Exception as exc:
        return None, _format_sandbox_lookup_error(exc)


def _get_file_version(sb: modal.Sandbox, path: str) -> tuple[str | None, str | None]:
    p = sb.exec("python3", "-c", FILE_VERSION_SCRIPT, path)
    p.wait()
    if p.returncode != 0:
        stderr = p.stderr.read().strip()
        return None, f"Version check failed: {stderr or 'unknown error'}"
    version = p.stdout.read().strip()
    return (version or None), None


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
    provided_identity = _parse_commit_identity(data.get("github_identity"))
    repo = data.get("repo", "")
    branch = data.get("branch", "main")

    if repo:
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
    else:
        p = sb.exec("mkdir", "-p", "/workspace")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            sb.terminate()
            return {"error": f"Workspace setup failed: {stderr}", "sandbox_id": None}

    # Configure git identity so commits work inside the sandbox
    if provided_identity:
        name, email = provided_identity
    elif repo and github_token:
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
        return {
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "truncated": False,
            "error": "Missing sandbox_id or command",
        }

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "truncated": False,
            "error": sandbox_error or "Sandbox unavailable",
        }
    if not _validate_owner_token(sb, owner_token):
        return {
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "truncated": False,
            "error": "Unauthorized sandbox access",
        }
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

    # Normalize relative paths to /workspace
    if path and not os.path.isabs(path):
        path = os.path.join("/workspace", path)

    if not sandbox_id:
        return {"error": "Missing sandbox_id"}
    if action not in ("read", "write", "list", "delete", "hydrate", "batch_write"):
        return {"error": f"Unknown file operation: {action}"}

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        error_message = sandbox_error or "Sandbox unavailable"
        if action in ("write", "delete", "hydrate"):
            return {"ok": False, "error": error_message}
        if action == "read":
            return {"error": error_message, "content": ""}
        return {"error": error_message, "entries": []}

    if not _validate_owner_token(sb, owner_token):
        if action in ("write", "delete", "hydrate"):
            return {"ok": False, "error": "Unauthorized sandbox access"}
        if action == "read":
            return {"error": "Unauthorized sandbox access", "content": ""}
        return {"error": "Unauthorized sandbox access", "entries": []}

    if action == "read":
        if not path:
            return {"error": "Missing sandbox_id or path"}

        # Optional line-range parameters
        raw_start = data.get("start_line")
        raw_end = data.get("end_line")
        use_range = raw_start is not None or raw_end is not None

        if use_range:
            try:
                start_line = int(raw_start) if raw_start is not None else 1
            except (TypeError, ValueError):
                return {"error": f"Invalid start_line: {raw_start!r}. Expected a positive integer.", "content": ""}

            try:
                end_line = int(raw_end) if raw_end is not None else None
            except (TypeError, ValueError):
                return {"error": f"Invalid end_line: {raw_end!r}. Expected a positive integer.", "content": ""}

            start_line = max(1, start_line)
            if end_line is not None and end_line < 1:
                return {"error": f"Invalid end_line: {end_line}. Expected a positive integer.", "content": ""}

            if end_line is not None and start_line > end_line:
                return {"error": f"Invalid range: start_line ({start_line}) > end_line ({end_line})", "content": ""}

            # Use sed for line-range reads
            if end_line is not None:
                p = sb.exec("sed", "-n", f"{start_line},{end_line}p", path)
            else:
                p = sb.exec("sed", "-n", f"{start_line},$p", path)
        else:
            p = sb.exec("cat", path)

        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"error": f"Read failed: {stderr}", "content": ""}

        content = p.stdout.read()
        # Version hash is always computed on the full file (stale-write protection)
        version, version_error = _get_file_version(sb, path)
        if version_error:
            return {"error": version_error, "content": ""}

        max_read_chars = 200_000  # 200KB — fits files up to ~3000 lines without chunking
        result = {"content": content[:max_read_chars], "truncated": len(content) > max_read_chars, "version": version}
        if use_range:
            result["start_line"] = start_line
            if end_line is not None:
                result["end_line"] = end_line
        return result

    if action == "write":
        content = str(data.get("content", ""))
        expected_version_raw = data.get("expected_version")
        expected_version = expected_version_raw.strip() if isinstance(expected_version_raw, str) else ""
        if not path:
            return {"ok": False, "error": "Missing sandbox_id or path"}

        # Consolidated write: version check + mkdir + write + verify + hash
        # in a single subprocess call (was 5 separate exec calls).
        encoded = base64.b64encode(content.encode()).decode()
        write_payload = json.dumps({
            "path": path,
            "content_b64": encoded,
            "expected_version": expected_version,
        })
        p = sb.exec("python3", "-c", WRITE_FILE_SCRIPT, write_payload)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Write failed: {stderr}"}

        stdout = p.stdout.read().strip()
        if not stdout:
            return {"ok": False, "error": "Write script produced no output"}

        try:
            result = json.loads(stdout)
        except Exception:
            return {"ok": False, "error": f"Write script produced invalid JSON: {stdout[:200]}"}

        return result

    if action == "batch_write":
        files = data.get("files", [])
        if not isinstance(files, list) or len(files) == 0:
            return {"ok": False, "error": "Missing or empty files array", "results": []}
        if len(files) > 20:
            return {"ok": False, "error": "batch_write limited to 20 files per request", "results": []}

        # Use the BATCH_WRITE_SCRIPT to process all files in a single subprocess.
        batch_entries = []
        for entry in files:
            file_path = entry.get("path", "")
            file_content = str(entry.get("content", ""))
            expected_ver_raw = entry.get("expected_version")
            expected_ver = expected_ver_raw.strip() if isinstance(expected_ver_raw, str) else ""
            batch_entries.append({
                "path": file_path,
                "content_b64": base64.b64encode(file_content.encode()).decode(),
                "expected_version": expected_ver,
            })

        batch_payload = json.dumps({"files": batch_entries})
        p = sb.exec("python3", "-c", BATCH_WRITE_SCRIPT, batch_payload)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Batch write failed: {stderr}", "results": []}

        stdout = p.stdout.read().strip()
        if not stdout:
            return {"ok": False, "error": "Batch write script produced no output", "results": []}

        try:
            batch_result = json.loads(stdout)
        except Exception:
            return {"ok": False, "error": f"Batch write script produced invalid JSON: {stdout[:200]}", "results": []}

        results = batch_result.get("results", [])
        all_ok = all(r.get("ok", False) for r in results)
        return {"ok": all_ok, "results": results}

    if action == "hydrate":
        archive_base64 = str(data.get("archive_base64", "")).strip()
        target = str(data.get("path", "/workspace") or "/workspace")
        archive_format = str(data.get("format", "tar.gz") or "tar.gz")
        if not archive_base64:
            return {"ok": False, "error": "Missing archive_base64"}
        if archive_format != "tar.gz":
            return {"ok": False, "error": "Unsupported format"}
        if not target.startswith("/workspace"):
            return {"ok": False, "error": "Path must be within /workspace"}

        tmp_b64 = "/tmp/restore.tar.gz.b64"
        tmp_archive = "/tmp/restore.tar.gz"
        escaped_target = target.replace("'", "'\\''")

        sb.exec("rm", "-f", tmp_b64, tmp_archive).wait()
        chunk_size = 120_000
        for i in range(0, len(archive_base64), chunk_size):
            chunk = archive_base64[i : i + chunk_size].replace("'", "'\\''")
            p = sb.exec("bash", "-lc", f"printf '%s' '{chunk}' >> {tmp_b64}")
            p.wait()
            if p.returncode != 0:
                stderr = p.stderr.read()
                return {"ok": False, "error": f"Snapshot upload failed: {stderr}"}

        p = sb.exec("bash", "-lc", f"base64 -d {tmp_b64} > {tmp_archive}")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Snapshot decode failed: {stderr}"}

        p = sb.exec("tar", "tzf", tmp_archive)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Snapshot validation failed: {stderr}"}

        p = sb.exec("bash", "-lc", f"mkdir -p '{escaped_target}' && find '{escaped_target}' -mindepth 1 -maxdepth 1 -exec rm -rf {{}} +")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Workspace cleanup failed: {stderr}"}

        p = sb.exec("tar", "xzf", tmp_archive, "-C", target)
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Snapshot restore failed: {stderr}"}

        p = sb.exec("bash", "-lc", f"find '{escaped_target}' -type f | wc -l")
        p.wait()
        restored_files_raw = p.stdout.read().strip() if p.returncode == 0 else "0"
        restored_files = int(restored_files_raw) if restored_files_raw.isdigit() else 0

        sb.exec("rm", "-f", tmp_b64, tmp_archive).wait()
        return {"ok": True, "restored_files": restored_files}

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

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {"error": sandbox_error or "Sandbox unavailable", "diff": ""}
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
    from playwright.sync_api import sync_playwright

    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    url = str(data.get("url", "")).strip()

    if not sandbox_id or not url:
        return {"ok": False, "error": "Missing sandbox_id or url"}

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {"ok": False, "error": sandbox_error or "Sandbox unavailable"}
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
    from playwright.sync_api import sync_playwright

    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    url = str(data.get("url", "")).strip()
    instruction = str(data.get("instruction", "")).strip()

    if not sandbox_id or not url:
        return {"ok": False, "error": "Missing sandbox_id or url"}

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {"ok": False, "error": sandbox_error or "Sandbox unavailable"}
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

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {"ok": False, "error": sandbox_error or "Sandbox unavailable"}
    if not _validate_owner_token(sb, owner_token):
        return {"ok": False, "error": "Unauthorized sandbox access"}
    sb.terminate()
    return {"ok": True}


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def create_archive(data: dict):
    """Create a base64-encoded tar.gz archive from a workspace path."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    path = str(data.get("path", "/workspace") or "/workspace")
    archive_format = str(data.get("format", "tar.gz") or "tar.gz")

    if not sandbox_id:
        return {"ok": False, "error": "Missing sandbox_id"}
    if archive_format != "tar.gz":
        return {"ok": False, "error": "Unsupported format"}
    if not path.startswith("/"):
        return {"ok": False, "error": "Path must be absolute"}

    resolved_path = os.path.realpath(path)
    if resolved_path != "/workspace" and not resolved_path.startswith("/workspace/"):
        return {"ok": False, "error": "Path must be within /workspace"}

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        return {"ok": False, "error": sandbox_error or "Sandbox unavailable"}
    if not _validate_owner_token(sb, owner_token):
        return {"ok": False, "error": "Unauthorized sandbox access"}

    try:
        p = sb.exec(
            "tar",
            "czf",
            "/tmp/archive.tar.gz",
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=__pycache__",
            "--exclude=.venv",
            "--exclude=dist",
            "--exclude=build",
            "-C",
            resolved_path,
            ".",
        )
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Archive creation failed: {stderr}"}

        p = sb.exec("bash", "-c", "wc -c < /tmp/archive.tar.gz")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Archive size check failed: {stderr}"}

        size_raw = p.stdout.read().strip()
        size_bytes = int(size_raw) if size_raw.isdigit() else 0
        if size_bytes > MAX_ARCHIVE_BYTES:
            return {"ok": False, "error": f"Archive exceeds max size of {MAX_ARCHIVE_BYTES} bytes"}

        p = sb.exec("base64", "/tmp/archive.tar.gz")
        p.wait()
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"ok": False, "error": f"Archive encoding failed: {stderr}"}

        archive_base64 = p.stdout.read().replace("\n", "")
        return {
            "ok": True,
            "archive_base64": archive_base64,
            "size_bytes": size_bytes,
            "format": "tar.gz",
        }
    finally:
        sb.exec("rm", "-f", "/tmp/archive.tar.gz").wait()
