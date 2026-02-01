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
def cleanup(data: dict):
    """Terminate a sandbox."""
    sandbox_id = data.get("sandbox_id")

    if not sandbox_id:
        return {"ok": False, "error": "Missing sandbox_id"}

    sb = modal.Sandbox.from_id(sandbox_id)
    sb.terminate()
    return {"ok": True}
