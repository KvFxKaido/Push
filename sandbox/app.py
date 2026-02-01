"""
Modal Python App — Sandbox CRUD for Diff.

Exposes 6 web endpoints as plain HTTPS POST routes.
Each endpoint receives JSON and returns JSON.
Browser never talks to this directly — Cloudflare Worker proxies all calls.

Deploy: cd sandbox && modal deploy app.py
"""

import modal
import base64

app = modal.App("diff-sandbox")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl")
    .pip_install("ruff", "pytest")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
)


@app.function()
@modal.web_endpoint(method="POST")
def create(data: dict):
    """Clone repo into a new sandbox, return sandbox_id."""
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=image,
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

    return {"sandbox_id": sb.object_id, "status": "ready"}


@app.function()
@modal.web_endpoint(method="POST")
def exec_command(data: dict):
    """Run a command in an existing sandbox."""
    sandbox_id = data.get("sandbox_id")
    command = data.get("command", "")
    workdir = data.get("workdir", "/workspace")

    if not sandbox_id or not command:
        return {"error": "Missing sandbox_id or command", "exit_code": -1}

    sb = modal.Sandbox.from_id(sandbox_id)
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


@app.function()
@modal.web_endpoint(method="POST")
def read_file(data: dict):
    """Read a file from the sandbox."""
    sandbox_id = data.get("sandbox_id")
    path = data.get("path", "")

    if not sandbox_id or not path:
        return {"error": "Missing sandbox_id or path"}

    sb = modal.Sandbox.from_id(sandbox_id)
    p = sb.exec("cat", path)
    p.wait()

    if p.returncode != 0:
        stderr = p.stderr.read()
        return {"error": f"Read failed: {stderr}", "content": ""}

    content = p.stdout.read()
    return {"content": content[:50_000], "truncated": len(content) > 50_000}


@app.function()
@modal.web_endpoint(method="POST")
def write_file(data: dict):
    """Write a file in the sandbox."""
    sandbox_id = data.get("sandbox_id")
    path = data.get("path", "")
    content = data.get("content", "")

    if not sandbox_id or not path:
        return {"ok": False, "error": "Missing sandbox_id or path"}

    sb = modal.Sandbox.from_id(sandbox_id)

    # Use base64 to safely transfer content with special characters
    encoded = base64.b64encode(content.encode()).decode()
    p = sb.exec(
        "bash",
        "-c",
        f"mkdir -p \"$(dirname '{path}')\" && echo '{encoded}' | base64 -d > '{path}'",
    )
    p.wait()

    return {"ok": p.returncode == 0}


@app.function()
@modal.web_endpoint(method="POST")
def get_diff(data: dict):
    """Get git diff of all changes."""
    sandbox_id = data.get("sandbox_id")

    if not sandbox_id:
        return {"error": "Missing sandbox_id", "diff": ""}

    sb = modal.Sandbox.from_id(sandbox_id)
    p = sb.exec("bash", "-c", "cd /workspace && git add -A && git diff --cached")
    p.wait()

    diff = p.stdout.read()
    return {"diff": diff[:20_000], "truncated": len(diff) > 20_000}


@app.function()
@modal.web_endpoint(method="POST")
def list_dir(data: dict):
    """List directory contents with metadata."""
    sandbox_id = data.get("sandbox_id")
    path = data.get("path", "/workspace")

    if not sandbox_id:
        return {"error": "Missing sandbox_id", "entries": []}

    sb = modal.Sandbox.from_id(sandbox_id)

    # Use a single command to get structured output: name, type, size
    # Output format per line: TYPE\tSIZE\tNAME (d=dir, f=file)
    cmd = (
        f"cd '{path}' 2>/dev/null && "
        "for f in * .*; do "
        "  [ \"$f\" = '.' ] || [ \"$f\" = '..' ] || [ \"$f\" = '*' ] && continue; "
        "  if [ -d \"$f\" ]; then echo \"d\\t0\\t$f\"; "
        "  elif [ -f \"$f\" ]; then stat -c 'd\\t%s\\t%n' \"$f\" 2>/dev/null || echo \"f\\t0\\t$f\"; "
        "  fi; "
        "done"
    )
    # Fix: stat format for files should use 'f' not 'd'
    cmd = (
        f"cd '{path}' 2>/dev/null && "
        "for f in * .*; do "
        "  [ \"$f\" = '.' ] || [ \"$f\" = '..' ] || [ \"$f\" = '*' ] && continue; "
        "  if [ -d \"$f\" ]; then echo \"d\\t0\\t$f\"; "
        "  elif [ -f \"$f\" ]; then stat -c 'f\\t%s\\t%n' \"$f\" 2>/dev/null || echo \"f\\t0\\t$f\"; "
        "  fi; "
        "done"
    )

    p = sb.exec("bash", "-c", cmd)
    p.wait()

    if p.returncode != 0:
        stderr = p.stderr.read()
        return {"error": f"List failed: {stderr}", "entries": []}

    entries = []
    stdout = p.stdout.read()
    for line in stdout.strip().split("\n"):
        if not line:
            continue
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        entry_type, size_str, name = parts
        entries.append({
            "name": name,
            "path": f"{path.rstrip('/')}/{name}",
            "type": "directory" if entry_type == "d" else "file",
            "size": int(size_str) if size_str.isdigit() else 0,
        })

    # Sort: directories first, then files, both alphabetical
    entries.sort(key=lambda e: (0 if e["type"] == "directory" else 1, e["name"].lower()))

    return {"entries": entries}


@app.function()
@modal.web_endpoint(method="POST")
def delete_file(data: dict):
    """Delete a file or directory from the sandbox."""
    sandbox_id = data.get("sandbox_id")
    path = data.get("path", "")

    if not sandbox_id or not path:
        return {"ok": False, "error": "Missing sandbox_id or path"}

    # Safety: prevent deleting workspace root or system paths
    if path in ("/", "/workspace", "/workspace/"):
        return {"ok": False, "error": "Cannot delete workspace root"}

    sb = modal.Sandbox.from_id(sandbox_id)
    p = sb.exec("rm", "-rf", path)
    p.wait()

    return {"ok": p.returncode == 0}


@app.function()
@modal.web_endpoint(method="POST")
def rename_file(data: dict):
    """Rename or move a file/directory in the sandbox."""
    sandbox_id = data.get("sandbox_id")
    old_path = data.get("old_path", "")
    new_path = data.get("new_path", "")

    if not sandbox_id or not old_path or not new_path:
        return {"ok": False, "error": "Missing sandbox_id, old_path, or new_path"}

    sb = modal.Sandbox.from_id(sandbox_id)

    # Ensure parent directory of new_path exists
    p = sb.exec("bash", "-c", f"mkdir -p \"$(dirname '{new_path}')\" && mv '{old_path}' '{new_path}'")
    p.wait()

    if p.returncode != 0:
        stderr = p.stderr.read()
        return {"ok": False, "error": f"Rename failed: {stderr}"}

    return {"ok": True}


@app.function()
@modal.web_endpoint(method="POST")
def cleanup(data: dict):
    """Terminate a sandbox."""
    sandbox_id = data.get("sandbox_id")

    if not sandbox_id:
        return {"ok": False, "error": "Missing sandbox_id"}

    sb = modal.Sandbox.from_id(sandbox_id)
    sb.terminate()
    return {"ok": True}
