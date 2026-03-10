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
import threading
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
endpoint_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")
OWNER_TOKEN_FILE = "/tmp/push-owner-token"
WORKSPACE_REVISION_FILE = "/tmp/push-workspace-revision"
MAX_ARCHIVE_BYTES = 100_000_000
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
# Accepts JSON via a temp file whose path is passed as sys.argv[1].
# Outputs a JSON result: { ok, bytes_written?, new_version?, workspace_revision?, code?, expected_version?, current_version?, error? }
WRITE_FILE_SCRIPT = """
import hashlib, pathlib, base64, json, os, sys

try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Invalid JSON input: {exc}"}))
    sys.exit(0)

path_str = data.get("path", "")
content_b64 = data.get("content_b64", "")
expected_version = data.get("expected_version", "")
expected_workspace_revision = data.get("expected_workspace_revision")
revision_file = pathlib.Path(sys.argv[2])
lock_file = revision_file.with_suffix(revision_file.suffix + ".lock")

if not path_str:
    print(json.dumps({"ok": False, "error": "Missing path"}))
    sys.exit(0)

# Normalize relative paths to /workspace and block traversal
if not os.path.isabs(path_str):
    path_str = os.path.join("/workspace", path_str)
path_str = os.path.normpath(path_str)
if not path_str.startswith("/workspace/") and path_str != "/workspace":
    print(json.dumps({"ok": False, "error": f"Path outside /workspace is not allowed: {path_str}"}))
    sys.exit(0)

p = pathlib.Path(path_str)

try:
    import fcntl, tempfile
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, "w", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            current_workspace_revision = int(revision_file.read_text(encoding="utf-8").strip()) if revision_file.exists() else 0
        except Exception:
            current_workspace_revision = 0

        if expected_workspace_revision is not None:
            try:
                expected_workspace_revision = int(expected_workspace_revision)
            except Exception:
                print(json.dumps({"ok": False, "error": f"Invalid expected_workspace_revision: {expected_workspace_revision}"}))
                sys.exit(0)
            if current_workspace_revision != expected_workspace_revision:
                print(json.dumps({
                    "ok": False,
                    "code": "WORKSPACE_CHANGED",
                    "error": "Workspace changed since last read. Re-read before writing.",
                    "expected_workspace_revision": expected_workspace_revision,
                    "current_workspace_revision": current_workspace_revision,
                }))
                sys.exit(0)

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
                        "workspace_revision": current_workspace_revision,
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

        # Step 3: Write content via atomic temp + rename to prevent partial writes
        try:
            content = base64.b64decode(content_b64)
            fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path_str))
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
                # Preserve permissions of the original file if it exists
                try:
                    mode = os.stat(path_str).st_mode
                    os.chmod(tmp_path, mode)
                except FileNotFoundError:
                    pass
                os.rename(tmp_path, path_str)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"Write failed: {exc}"}))
            sys.exit(0)

        # Step 4+5: Verify size + compute new version + bump workspace revision
        try:
            actual_size = p.stat().st_size
            new_version = hashlib.sha256(p.read_bytes()).hexdigest()
            next_workspace_revision = current_workspace_revision + 1
            revision_file.write_text(str(next_workspace_revision), encoding="utf-8")
            print(json.dumps({
                "ok": True,
                "bytes_written": actual_size,
                "new_version": new_version,
                "workspace_revision": next_workspace_revision,
            }))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"Verification failed: {exc}"}))
            sys.exit(0)
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Write failed: {exc}"}))
    sys.exit(0)
"""

# Batch write script — writes multiple files in a single subprocess call.
# Accepts JSON via a temp file whose path is passed as sys.argv[1].
# Outputs a JSON result: { ok, workspace_revision?, results: [{ ok, path, bytes_written?, new_version?, ... }] }
BATCH_WRITE_SCRIPT = """
import hashlib, pathlib, base64, json, os, sys

try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception as exc:
    print(json.dumps({"results": [{"ok": False, "error": f"Invalid JSON input: {exc}"}]}))
    sys.exit(0)

files = data.get("files", [])
expected_workspace_revision = data.get("expected_workspace_revision")
revision_file = pathlib.Path(sys.argv[2])
lock_file = revision_file.with_suffix(revision_file.suffix + ".lock")
results = []

try:
    import fcntl, tempfile
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, "w", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            current_workspace_revision = int(revision_file.read_text(encoding="utf-8").strip()) if revision_file.exists() else 0
        except Exception:
            current_workspace_revision = 0

        if expected_workspace_revision is not None:
            try:
                expected_workspace_revision = int(expected_workspace_revision)
            except Exception:
                print(json.dumps({
                    "ok": False,
                    "error": f"Invalid expected_workspace_revision: {expected_workspace_revision}",
                    "results": [],
                }))
                sys.exit(0)
            if current_workspace_revision != expected_workspace_revision:
                print(json.dumps({
                    "ok": False,
                    "code": "WORKSPACE_CHANGED",
                    "error": "Workspace changed since last read. Re-read before writing.",
                    "expected_workspace_revision": expected_workspace_revision,
                    "current_workspace_revision": current_workspace_revision,
                    "results": [],
                }))
                sys.exit(0)

        wrote_any = False

        for f in files:
            path_str = f.get("path", "")
            content_b64 = f.get("content_b64", "")
            expected_version = f.get("expected_version", "")

            if not path_str:
                results.append({"ok": False, "path": path_str, "error": "Missing path"})
                continue

            # Normalize relative paths to /workspace and block traversal
            if not os.path.isabs(path_str):
                path_str = os.path.join("/workspace", path_str)
            path_str = os.path.normpath(path_str)
            if not path_str.startswith("/workspace/") and path_str != "/workspace":
                results.append({"ok": False, "path": path_str, "error": f"Path outside /workspace is not allowed: {path_str}"})
                continue

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
                            "workspace_revision": current_workspace_revision,
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

            # Write content via atomic temp + rename
            try:
                content = base64.b64decode(content_b64)
                fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path_str))
                try:
                    with os.fdopen(fd, 'wb') as f:
                        f.write(content)
                        f.flush()
                        os.fsync(f.fileno())
                    # Preserve permissions of the original file if it exists
                    try:
                        mode = os.stat(path_str).st_mode
                        os.chmod(tmp_path, mode)
                    except FileNotFoundError:
                        pass
                    os.rename(tmp_path, path_str)
                except Exception:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    raise
            except Exception as exc:
                results.append({"ok": False, "path": path_str, "error": f"Write failed: {exc}"})
                continue

            # Verify + new version
            try:
                actual_size = p.stat().st_size
                new_version = hashlib.sha256(p.read_bytes()).hexdigest()
                wrote_any = True
                results.append({"ok": True, "path": path_str, "bytes_written": actual_size, "new_version": new_version})
            except Exception as exc:
                results.append({"ok": False, "path": path_str, "error": f"Verification failed: {exc}"})

        next_workspace_revision = current_workspace_revision
        if wrote_any:
            next_workspace_revision += 1
            revision_file.write_text(str(next_workspace_revision), encoding="utf-8")
        print(json.dumps({"ok": all(r.get("ok", False) for r in results), "workspace_revision": next_workspace_revision, "results": results}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Batch write failed: {exc}", "results": []}))
"""


def _wait_with_timeout(p, timeout_seconds: int = 55) -> bool:
    """Wait for a Modal subprocess with a timeout. Returns True if completed, False if timed out.

    Default is 55s — under the Worker's 60s timeout so the client gets a proper
    error response instead of a connection drop.

    If p.wait() raises (gRPC disconnect, Modal timeout, etc.), the exception is
    captured and re-raised in the calling thread so callers don't mistake a crash
    for a successful completion.
    """
    done = threading.Event()
    exc_holder: list[BaseException] = []

    def wait_thread():
        try:
            p.wait()
        except BaseException as exc:
            exc_holder.append(exc)
        finally:
            done.set()

    t = threading.Thread(target=wait_thread, daemon=True)
    t.start()
    completed = done.wait(timeout=timeout_seconds)
    if exc_holder:
        raise exc_holder[0]
    return completed


def _sandbox_error_response(exc: Exception, default_fields: dict | None = None) -> dict:
    """Build a JSON error response for unhandled sandbox/Modal exceptions.

    Instead of letting these bubble up as raw 500s, callers catch and return
    structured JSON so the client gets a proper error_type it can act on.
    """
    exc_type = type(exc).__name__
    msg = (
        "Sandbox container error. The container may be unhealthy "
        f"— try restarting the sandbox. ({exc_type})"
    )
    result = default_fields.copy() if default_fields else {}
    result["error"] = msg
    result["code"] = "CONTAINER_ERROR"
    return result


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
    if not _wait_with_timeout(p, timeout_seconds=10):
        return None
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
        if not _wait_with_timeout(p, timeout_seconds=10):
            return False
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


def _sandbox_tmp_path(prefix: str, suffix: str = ".json") -> str:
    """Create a request-unique temp path inside the sandbox."""
    return f"/tmp/{prefix}-{secrets.token_hex(8)}{suffix}"


def _write_temp_payload(sb: modal.Sandbox, payload: str, tmp_path: str = "/tmp/push_payload.json") -> str | None:
    """Write a JSON payload to a temp file in the sandbox via chunked printf.

    Returns None on success, or an error string on failure.
    Uses chunked writes to avoid Linux's MAX_ARG_STRLEN (128KB per arg) limit.
    """
    try:
        p = sb.exec("rm", "-f", tmp_path)
        if not _wait_with_timeout(p, timeout_seconds=10):
            return "Temp file cleanup timed out"
    except Exception as exc:
        return f"Temp file cleanup failed: {type(exc).__name__}: {exc}"
    chunk_size = 100_000  # well under 128KB single-arg limit
    for i in range(0, len(payload), chunk_size):
        chunk = payload[i : i + chunk_size].replace("'", "'\\''")
        try:
            p = sb.exec("bash", "-c", f"printf '%s' '{chunk}' >> {tmp_path}")
        except Exception as exc:
            return f"Payload upload exec failed: {type(exc).__name__}: {exc}"
        if not _wait_with_timeout(p, timeout_seconds=15):
            return "Payload upload timed out"
        if p.returncode != 0:
            stderr = p.stderr.read()
            return f"Payload upload failed: {stderr}"
    return None


def _get_file_version(sb: modal.Sandbox, path: str) -> tuple[str | None, str | None]:
    p = sb.exec("python3", "-c", FILE_VERSION_SCRIPT, path)
    if not _wait_with_timeout(p, timeout_seconds=15):
        return None, "Version check timed out"
    if p.returncode != 0:
        stderr = p.stderr.read().strip()
        return None, f"Version check failed: {stderr or 'unknown error'}"
    version = p.stdout.read().strip()
    return (version or None), None


def _set_workspace_revision(sb: modal.Sandbox, revision: int) -> str | None:
    p = sb.exec(
        "python3",
        "-c",
        (
            "import pathlib,sys;"
            "path=pathlib.Path(sys.argv[1]);"
            "path.parent.mkdir(parents=True, exist_ok=True);"
            "path.write_text(str(int(sys.argv[2])), encoding='utf-8')"
        ),
        WORKSPACE_REVISION_FILE,
        str(revision),
    )
    if not _wait_with_timeout(p, timeout_seconds=10):
        return "Workspace revision init timed out"
    if p.returncode != 0:
        stderr = p.stderr.read().strip()
        return f"Workspace revision init failed: {stderr or 'unknown error'}"
    return None


def _get_workspace_revision(sb: modal.Sandbox) -> tuple[int | None, str | None]:
    p = sb.exec(
        "python3",
        "-c",
        """
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = "0"
if path.exists():
    value = path.read_text(encoding="utf-8").strip() or "0"
print(int(value))
""",
        WORKSPACE_REVISION_FILE,
    )
    if not _wait_with_timeout(p, timeout_seconds=10):
        return None, "Workspace revision read timed out"
    if p.returncode != 0:
        stderr = p.stderr.read().strip()
        return None, f"Workspace revision read failed: {stderr or 'unknown error'}"
    raw = p.stdout.read().strip() or "0"
    try:
        return int(raw), None
    except ValueError:
        return 0, None


def _bump_workspace_revision(sb: modal.Sandbox) -> tuple[int | None, str | None]:
    p = sb.exec(
        "python3",
        "-c",
        """
import fcntl
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lock = path.with_suffix(path.suffix + ".lock")
lock.parent.mkdir(parents=True, exist_ok=True)

with open(lock, "w", encoding="utf-8") as fh:
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
    raw = path.read_text(encoding="utf-8").strip() if path.exists() else "0"
    try:
        current = int(raw or "0")
    except ValueError:
        current = 0
    current += 1
    path.write_text(str(current), encoding="utf-8")
    print(current)
""",
        WORKSPACE_REVISION_FILE,
    )
    if not _wait_with_timeout(p, timeout_seconds=10):
        return None, "Workspace revision bump timed out"
    if p.returncode != 0:
        stderr = p.stderr.read().strip()
        return None, f"Workspace revision bump failed: {stderr or 'unknown error'}"
    raw = p.stdout.read().strip() or "0"
    try:
        return int(raw), None
    except ValueError:
        return None, "Workspace revision bump returned invalid data"


def _truncate_read_content(content: str, start_line: int, max_chars: int) -> dict:
    """Truncate read content at line boundaries when possible.

    Returns:
      {
        "content": <visible prefix>,
        "truncated": bool,
        "truncated_at_line"?: int,  # line to resume from / line where truncation starts
        "remaining_bytes"?: int,
      }
    """
    if len(content) <= max_chars:
        return {"content": content, "truncated": False}

    lines = content.splitlines(keepends=True)
    if not lines:
        visible = content[:max_chars]
        return {
            "content": visible,
            "truncated": True,
            "truncated_at_line": start_line,
            "remaining_bytes": len(content[len(visible) :].encode("utf-8")),
        }

    visible_parts: list[str] = []
    used_chars = 0
    used_lines = 0

    for line in lines:
        if used_chars + len(line) > max_chars:
            if used_lines == 0:
                visible = line[:max_chars]
                return {
                    "content": visible,
                    "truncated": True,
                    "truncated_at_line": start_line,
                    "remaining_bytes": len(content[len(visible) :].encode("utf-8")),
                }
            break
        visible_parts.append(line)
        used_chars += len(line)
        used_lines += 1

    visible = "".join(visible_parts)
    remaining = content[len(visible) :]
    return {
        "content": visible,
        "truncated": True,
        "truncated_at_line": start_line + used_lines,
        "remaining_bytes": len(remaining.encode("utf-8")),
    }


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
    revision_error = _set_workspace_revision(sb, 0)
    if revision_error:
        sb.terminate()
        return {"error": revision_error, "sandbox_id": None}

    return {"sandbox_id": sb.object_id, "owner_token": owner_token, "status": "ready", "workspace_revision": 0}


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def exec_command(data: dict):
    """Run a command in an existing sandbox."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    command = data.get("command", "")
    workdir = data.get("workdir", "/workspace")
    mark_workspace_mutated = bool(data.get("mark_workspace_mutated"))

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
    try:
        p = sb.exec("bash", "-c", f"cd {workdir} && {command}")
        completed = _wait_with_timeout(p, timeout_seconds=110)

        if not completed:
            workspace_revision, _ = _get_workspace_revision(sb)
            return {
                "stdout": "",
                "stderr": "Command timed out after 110 seconds. The operation may still be running in the sandbox.",
                "exit_code": -1,
                "truncated": False,
                "error": "Command execution timed out",
                "workspace_revision": workspace_revision,
            }

        stdout = p.stdout.read()
        stderr = p.stderr.read()
        workspace_revision = None
        revision_error = None
        if mark_workspace_mutated:
            workspace_revision, revision_error = _bump_workspace_revision(sb)
        else:
            workspace_revision, revision_error = _get_workspace_revision(sb)
        if revision_error:
            return {
                "stdout": stdout[:10_000],
                "stderr": stderr[:5_000],
                "exit_code": p.returncode,
                "truncated": len(stdout) > 10_000 or len(stderr) > 5_000,
                "error": revision_error,
            }

        return {
            "stdout": stdout[:10_000],
            "stderr": stderr[:5_000],
            "exit_code": p.returncode,
            "truncated": len(stdout) > 10_000 or len(stderr) > 5_000,
            "workspace_revision": workspace_revision,
        }
    except Exception as exc:
        return _sandbox_error_response(exc, {"stdout": "", "stderr": "", "exit_code": -1, "truncated": False})


@app.function(image=endpoint_image)
@modal.fastapi_endpoint(method="POST")
def file_ops(data: dict):
    """Handle sandbox file operations through one endpoint (read/write/list/delete)."""
    sandbox_id = data.get("sandbox_id")
    owner_token = data.get("owner_token", "")
    action = data.get("action", "")
    path = data.get("path", "")

    # Normalize relative paths to /workspace (mirrors frontend normalizeSandboxPath)
    if path:
        trimmed = path.strip()
        if trimmed in ("/workspace", "workspace"):
            path = "/workspace"
        elif trimmed.startswith("/workspace/"):
            path = trimmed
        elif trimmed.startswith("workspace/"):
            path = "/" + trimmed
        elif not os.path.isabs(trimmed):
            path = "/workspace/" + trimmed
        else:
            path = trimmed
        path = os.path.normpath(path)

    if not sandbox_id:
        return {"error": "Missing sandbox_id"}
    if action not in ("read", "write", "list", "delete", "hydrate", "batch_write"):
        return {"error": f"Unknown file operation: {action}"}

    sb, sandbox_error = _load_sandbox(str(sandbox_id))
    if not sb:
        error_message = sandbox_error or "Sandbox unavailable"
        if action == "batch_write":
            return {"ok": False, "error": error_message, "results": []}
        if action in ("write", "delete", "hydrate"):
            return {"ok": False, "error": error_message}
        if action == "read":
            return {"error": error_message, "content": ""}
        return {"error": error_message, "entries": []}

    if not _validate_owner_token(sb, owner_token):
        if action == "batch_write":
            return {"ok": False, "error": "Unauthorized sandbox access", "results": []}
        if action in ("write", "delete", "hydrate"):
            return {"ok": False, "error": "Unauthorized sandbox access"}
        if action == "read":
            return {"error": "Unauthorized sandbox access", "content": ""}
        return {"error": "Unauthorized sandbox access", "entries": []}

    # Wrap all sandbox operations so Modal gRPC crashes return proper
    # JSON errors instead of raw 500s.
    try:
        return _file_ops_inner(sb, action, path, data)
    except Exception as exc:
        if action == "batch_write":
            return _sandbox_error_response(exc, {"ok": False, "results": []})
        if action in ("write", "delete", "hydrate"):
            return _sandbox_error_response(exc, {"ok": False})
        if action == "read":
            return _sandbox_error_response(exc, {"content": ""})
        return _sandbox_error_response(exc, {"entries": []})


def _file_ops_inner(sb, action: str, path: str, data: dict):
    """Inner file_ops logic, separated so the caller can catch container crashes."""

    if action == "read":
        if not path:
            return {"error": "Missing sandbox_id or path"}

        before_revision, before_revision_error = _get_workspace_revision(sb)
        if before_revision_error:
            return {"error": before_revision_error, "content": ""}

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

        if not _wait_with_timeout(p, timeout_seconds=25):
            return {"error": "File read timed out", "content": ""}
        if p.returncode != 0:
            stderr = p.stderr.read()
            return {"error": f"Read failed: {stderr}", "content": ""}

        content = p.stdout.read()
        # Version hash is always computed on the full file (stale-write protection)
        version, version_error = _get_file_version(sb, path)
        if version_error:
            return {"error": version_error, "content": ""}
        after_revision, after_revision_error = _get_workspace_revision(sb)
        if after_revision_error:
            return {"error": after_revision_error, "content": ""}
        if before_revision != after_revision:
            return {
                "error": "Workspace changed during read. Retry the read before editing.",
                "code": "WORKSPACE_CHANGED",
                "content": "",
                "expected_workspace_revision": before_revision,
                "current_workspace_revision": after_revision,
            }

        max_read_chars = 200_000  # 200KB — fits files up to ~3000 lines without chunking
        result = {
            **_truncate_read_content(content, start_line if use_range else 1, max_read_chars),
            "version": version,
            "workspace_revision": after_revision,
        }
        if use_range:
            result["start_line"] = start_line
            if end_line is not None:
                result["end_line"] = end_line
        return result

    if action in ("write", "batch_write"):
        # Health-check: verify the sandbox can execute before starting the
        # multi-step write flow.  A quick `true` catches dead containers early
        # and produces a clear error instead of an opaque InvalidError mid-write.
        try:
            ping = sb.exec("true")
            if not _wait_with_timeout(ping, timeout_seconds=10):
                code = "CONTAINER_ERROR"
                msg = "Sandbox health check timed out before write. The container may need to be restarted."
                if action == "batch_write":
                    return {"ok": False, "error": msg, "code": code, "results": []}
                return {"ok": False, "error": msg, "code": code}
        except Exception as exc:
            code = "CONTAINER_ERROR"
            msg = f"Sandbox health check failed before write: {type(exc).__name__}: {exc}"
            if action == "batch_write":
                return {"ok": False, "error": msg, "code": code, "results": []}
            return {"ok": False, "error": msg, "code": code}

    if action == "write":
        content = str(data.get("content", ""))
        expected_version_raw = data.get("expected_version")
        expected_version = expected_version_raw.strip() if isinstance(expected_version_raw, str) else ""
        expected_workspace_revision = data.get("expected_workspace_revision")
        if not path:
            return {"ok": False, "error": "Missing sandbox_id or path"}

        # Consolidated write: version check + mkdir + write + verify + hash
        # in a single subprocess call (was 5 separate exec calls).
        # Payload is written to a temp file to avoid MAX_ARG_STRLEN (128KB) and stdin pipe issues.
        encoded = base64.b64encode(content.encode()).decode()
        write_payload = json.dumps({
            "path": path,
            "content_b64": encoded,
            "expected_version": expected_version,
            "expected_workspace_revision": expected_workspace_revision,
        })
        tmp_path = _sandbox_tmp_path("push-write-payload")
        try:
            upload_err = _write_temp_payload(sb, write_payload, tmp_path)
            if upload_err:
                return {"ok": False, "error": upload_err}
            p = sb.exec("python3", "-c", WRITE_FILE_SCRIPT, tmp_path, WORKSPACE_REVISION_FILE)
            if not _wait_with_timeout(p, timeout_seconds=55):
                return {"ok": False, "error": "Write timed out after 55 seconds. The sandbox may be under heavy load."}
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
        finally:
            try:
                p = sb.exec("rm", "-f", tmp_path)
                _wait_with_timeout(p, timeout_seconds=5)
            except Exception:
                pass

    if action == "batch_write":
        files = data.get("files", [])
        expected_workspace_revision = data.get("expected_workspace_revision")
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

        batch_payload = json.dumps({
            "files": batch_entries,
            "expected_workspace_revision": expected_workspace_revision,
        })
        tmp_path = _sandbox_tmp_path("push-batch-payload")
        try:
            upload_err = _write_temp_payload(sb, batch_payload, tmp_path)
            if upload_err:
                return {"ok": False, "error": upload_err, "results": []}
            p = sb.exec("python3", "-c", BATCH_WRITE_SCRIPT, tmp_path, WORKSPACE_REVISION_FILE)
            if not _wait_with_timeout(p, timeout_seconds=55):
                return {"ok": False, "error": "Batch write timed out after 55 seconds.", "results": []}
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
            return {
                "ok": bool(batch_result.get("ok", all(r.get("ok", False) for r in results))),
                "results": results,
                "error": batch_result.get("error"),
                "code": batch_result.get("code"),
                "workspace_revision": batch_result.get("workspace_revision"),
                "expected_workspace_revision": batch_result.get("expected_workspace_revision"),
                "current_workspace_revision": batch_result.get("current_workspace_revision"),
            }
        finally:
            try:
                p = sb.exec("rm", "-f", tmp_path)
                _wait_with_timeout(p, timeout_seconds=5)
            except Exception:
                pass

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
        next_revision, revision_error = _bump_workspace_revision(sb)
        if revision_error:
            return {"ok": False, "error": revision_error}
        return {"ok": True, "restored_files": restored_files, "workspace_revision": next_revision}

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
    if p.returncode != 0:
        return {"ok": False, "error": "Delete failed"}
    next_revision, revision_error = _bump_workspace_revision(sb)
    if revision_error:
        return {"ok": False, "error": revision_error}
    return {"ok": True, "workspace_revision": next_revision}


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

    try:
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
    except Exception as exc:
        return _sandbox_error_response(exc, {"diff": ""})


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
    try:
        sb.terminate()
    except Exception as exc:
        err_msg = str(exc).lower()
        if "not found" in err_msg or "terminated" in err_msg or "closed" in err_msg:
            pass  # Container already gone — that's fine
        else:
            return {"ok": False, "error": f"Termination failed: {type(exc).__name__}"}
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
    except Exception as exc:
        return _sandbox_error_response(exc, {"ok": False})
    finally:
        try:
            sb.exec("rm", "-f", "/tmp/archive.tar.gz").wait()
        except Exception:
            pass
