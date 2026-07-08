package com.push.nativegit

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Capacitor bridge for the on-device git engine. Binds to the JS
 * `registerPlugin<NativeGitPlugin>('NativeGit')` in the web app by the `name`
 * below.
 *
 * Threading: JGit operations (clone/fetch/push especially) are blocking I/O, so
 * every method dispatches to a single-threaded executor and resolves/rejects
 * the `PluginCall` from there — never on the WebView/main thread. The single
 * thread also gives a cheap per-process serialization backstop; the real
 * working-copy lock lives in TS (`NativeGitBackend` → `createWorkingCopyLock`).
 *
 * Contract: reads reject on failure (the TS backend maps that to null); writes
 * resolve `{ ok:false, message }` on an ordinary git failure and reject only on
 * an unexpected bridge error.
 */
@CapacitorPlugin(name = "NativeGit")
class NativeGitPlugin : Plugin() {

  private val io = Executors.newSingleThreadExecutor()

  /** Resolve `block`'s result off-thread; reject on any throw (read semantics). */
  private fun resolveAsync(call: PluginCall, block: () -> JSObject) {
    io.execute {
      try {
        call.resolve(block())
      } catch (e: Exception) {
        call.reject(e.message ?: "git error", e)
      }
    }
  }

  /** Run a write off-thread; ordinary git failure → `{ ok:false, message }`. */
  private fun writeAsync(call: PluginCall, block: () -> Unit) {
    io.execute {
      val result = try {
        block()
        JSObject().put("ok", true)
      } catch (e: Exception) {
        JSObject().put("ok", false).put("message", e.message ?: "git error")
      }
      call.resolve(result)
    }
  }

  /**
   * Resolve a working-copy dir. Absolute paths pass through unchanged (the typed
   * contract); a relative path resolves against the app's private `filesDir`, so
   * a JS caller can pass a plain name (e.g. "smoke-clone") without knowing
   * Android's absolute storage path. Additive — absolute callers are unaffected.
   *
   * Defense in depth: JS callers derive a relative `dir` from `laneSegment`,
   * which replaces every `/` with `_` and strips leading dots, so a `..` path
   * component can't reach here — but this is the one path-resolution seam that
   * didn't enforce the sandbox boundary itself (unlike `safeChild` /
   * `extractDeltaOnto`). Canonical-check a relative dir against `filesDir` so a
   * future caller or a `laneSegment` regression can't silently escape the app
   * sandbox. Absolute dirs remain the caller's explicit responsibility.
   */
  private fun resolveDir(dir: String): String {
    if (File(dir).isAbsolute) return dir
    val filesDir = getContext().filesDir
    val resolved = File(filesDir, dir)
    val base = filesDir.canonicalPath
    val cp = resolved.canonicalPath
    if (cp != base && !cp.startsWith(base + File.separator)) {
      throw IllegalArgumentException("relative dir escapes the app sandbox: $dir")
    }
    return resolved.absolutePath
  }

  private fun PluginCall.requireDir(): String =
    getString("dir")?.let { resolveDir(it) } ?: throw IllegalArgumentException("missing 'dir'")

  @PluginMethod
  fun clone(call: PluginCall) {
    val url = call.getString("url") ?: return call.reject("missing 'url'")
    val dir = resolveDir(call.getString("dir") ?: return call.reject("missing 'dir'"))
    writeAsync(call) {
      JGitEngine.clone(url, dir, call.getString("branch"), call.getString("token"), call.getInt("depth"))
    }
  }

  @PluginMethod
  fun currentBranch(call: PluginCall) = resolveAsync(call) {
    JSObject().put("branch", JGitEngine.currentBranch(call.requireDir()))
  }

  @PluginMethod
  fun upstreamRef(call: PluginCall) = resolveAsync(call) {
    JSObject().put("ref", JGitEngine.upstreamRef(call.requireDir()))
  }

  @PluginMethod
  fun remoteUrl(call: PluginCall) = resolveAsync(call) {
    val url = JGitEngine.remoteUrl(
      call.requireDir(),
      call.getString("remote") ?: "origin",
      call.getBoolean("push", false) == true,
    )
    JSObject().put("url", url)
  }

  @PluginMethod
  fun headSha(call: PluginCall) = resolveAsync(call) {
    JSObject().put("sha", JGitEngine.headSha(call.requireDir(), call.getBoolean("short", false) == true))
  }

  @PluginMethod
  fun status(call: PluginCall) = resolveAsync(call) {
    JSObject().put("porcelain", JGitEngine.statusPorcelain(call.requireDir()))
  }

  @PluginMethod
  fun diff(call: PluginCall) = resolveAsync(call) {
    val result = JGitEngine.diff(call.requireDir())
    JSObject()
      .put("diff", result.diff)
      .put("truncated", result.truncated)
      .put("git_status", result.gitStatus)
      .also { if (result.error != null) it.put("error", result.error) }
  }

  @PluginMethod
  fun revParse(call: PluginCall) = resolveAsync(call) {
    val ref = call.getString("ref") ?: return@resolveAsync JSObject().put("sha", JSONObject.NULL)
    JSObject().put("sha", JGitEngine.revParse(call.requireDir(), ref) ?: JSONObject.NULL)
  }

  @PluginMethod
  fun mergeBase(call: PluginCall) = resolveAsync(call) {
    val a = call.getString("a") ?: return@resolveAsync JSObject().put("sha", JSONObject.NULL)
    val b = call.getString("b") ?: return@resolveAsync JSObject().put("sha", JSONObject.NULL)
    JSObject().put("sha", JGitEngine.mergeBase(call.requireDir(), a, b) ?: JSONObject.NULL)
  }

  @PluginMethod
  fun logPatch(call: PluginCall) = resolveAsync(call) {
    val range = call.getString("range") ?: return@resolveAsync JSObject().put("patch", JSONObject.NULL)
    JSObject().put("patch", JGitEngine.logPatch(call.requireDir(), range) ?: JSONObject.NULL)
  }

  @PluginMethod
  fun lsRemoteHead(call: PluginCall) = resolveAsync(call) {
    val branch = call.getString("branch") ?: return@resolveAsync JSObject()
      .put("ok", false)
      .put("sha", JSONObject.NULL)
    val result = JGitEngine.lsRemoteHead(
      call.requireDir(),
      call.getString("remote") ?: "origin",
      branch,
      call.getString("token"),
    )
    JSObject().put("ok", result.ok).put("sha", result.sha ?: JSONObject.NULL)
  }

  @PluginMethod
  fun readFile(call: PluginCall) = resolveAsync(call) {
    val path = call.getString("path") ?: return@resolveAsync JSObject()
      .put("content", "")
      .put("truncated", false)
      .put("error", "missing 'path'")
      .put("code", "EINVAL")
    val result = JGitEngine.readFile(
      call.requireDir(),
      path,
      call.getInt("startLine"),
      call.getInt("endLine"),
    )
    JSObject()
      .put("content", result.content)
      .put("truncated", result.truncated)
      .also {
        if (result.totalLines != null) it.put("totalLines", result.totalLines)
        if (result.error != null) it.put("error", result.error)
        if (result.code != null) it.put("code", result.code)
      }
  }

  @PluginMethod
  fun writeFile(call: PluginCall) = resolveAsync(call) {
    val path = call.getString("path") ?: return@resolveAsync JSObject()
      .put("ok", false)
      .put("error", "missing 'path'")
    val content = call.getString("content") ?: ""
    val result = JGitEngine.writeFile(call.requireDir(), path, content)
    JSObject()
      .put("ok", result.ok)
      .also {
        if (result.bytesWritten != null) it.put("bytesWritten", result.bytesWritten)
        if (result.error != null) it.put("error", result.error)
      }
  }

  @PluginMethod
  fun listDir(call: PluginCall) = resolveAsync(call) {
    val result = JGitEngine.listDir(call.requireDir(), call.getString("path"))
    val entries = JSArray()
    for (entry in result.entries) {
      entries.put(
        JSObject()
          .put("name", entry.name)
          .put("type", entry.type)
          .also { if (entry.size != null) it.put("size", entry.size) },
      )
    }
    JSObject()
      .put("entries", entries)
      .put("truncated", result.truncated)
      .also { if (result.error != null) it.put("error", result.error) }
  }

  @PluginMethod
  fun createBranch(call: PluginCall) {
    val name = call.getString("name") ?: return call.reject("missing 'name'")
    writeAsync(call) { JGitEngine.createBranch(call.requireDir(), name, call.getString("from")) }
  }

  @PluginMethod
  fun switchBranch(call: PluginCall) {
    val branch = call.getString("branch") ?: return call.reject("missing 'branch'")
    writeAsync(call) { JGitEngine.switchBranch(call.requireDir(), branch) }
  }

  @PluginMethod
  fun commit(call: PluginCall) {
    val message = call.getString("message") ?: return call.reject("missing 'message'")
    writeAsync(call) {
      JGitEngine.commit(call.requireDir(), message, call.getBoolean("addAll", true) == true)
    }
  }

  @PluginMethod
  fun push(call: PluginCall) {
    writeAsync(call) {
      JGitEngine.push(
        call.requireDir(),
        call.getString("remote") ?: "origin",
        call.getString("ref") ?: "HEAD",
        call.getBoolean("setUpstream", false) == true,
        call.getString("token"),
      )
    }
  }

  @PluginMethod
  fun fetch(call: PluginCall) {
    writeAsync(call) {
      JGitEngine.fetch(
        call.requireDir(),
        call.getString("remote") ?: "origin",
        call.getString("refspec"),
        call.getInt("depth"),
        call.getString("token"),
      )
    }
  }

  // -- Checkpoints ------------------------------------------------------------

  @PluginMethod
  fun commitWorkingTree(call: PluginCall) {
    val archive = call.getString("archiveBase64") ?: return call.reject("missing 'archiveBase64'")
    val message = call.getString("message") ?: "checkpoint"
    resolveAsync(call) {
      val result = JGitEngine.commitWorkingTree(call.requireDir(), archive, message)
      JSObject()
        .put("committed", result.committed)
        .put("commitId", result.commitId ?: JSONObject.NULL)
    }
  }

  @PluginMethod
  fun archiveCommit(call: PluginCall) {
    val commitId = call.getString("commitId") ?: return call.reject("missing 'commitId'")
    resolveAsync(call) {
      JSObject().put(
        "archiveBase64",
        JGitEngine.archiveCommit(call.requireDir(), commitId) ?: JSONObject.NULL,
      )
    }
  }

  @PluginMethod
  fun listCheckpoints(call: PluginCall) = resolveAsync(call) {
    val arr = JSArray()
    for (entry in JGitEngine.listCheckpoints(call.requireDir())) {
      arr.put(
        JSObject()
          .put("commitId", entry.commitId)
          .put("message", entry.message)
          .put("timestampMs", entry.timestampMs),
      )
    }
    JSObject().put("checkpoints", arr)
  }

  @PluginMethod
  fun pruneCheckpoints(call: PluginCall) {
    val keep = call.getInt("keep") ?: 50
    resolveAsync(call) {
      JSObject().put("pruned", JGitEngine.pruneCheckpoints(call.requireDir(), keep))
    }
  }

  @PluginMethod
  fun dropCheckpoint(call: PluginCall) {
    val commitId = call.getString("commitId") ?: return call.reject("missing 'commitId'")
    resolveAsync(call) {
      JSObject().put("dropped", JGitEngine.dropCheckpoint(call.requireDir(), commitId))
    }
  }

  @PluginMethod
  fun clearCheckpoints(call: PluginCall) = resolveAsync(call) {
    val dir = call.requireDir()
    // Destructive purge — refuse anything outside the app-private checkpoints area
    // so a bad caller (or an unexpected absolute dir) can never recursively delete
    // arbitrary app storage. The TS side only ever passes a lane dir or the
    // `checkpoints` root, both of which resolve under this guard.
    val root = File(getContext().filesDir, "checkpoints").canonicalPath
    val target = File(dir).canonicalPath
    if (target != root && !target.startsWith(root + File.separator)) {
      throw IllegalArgumentException("refusing to clear outside the checkpoints area")
    }
    JSObject().put("cleared", JGitEngine.clearCheckpoints(dir))
  }

  @PluginMethod
  fun listManifest(call: PluginCall) = resolveAsync(call) {
    val manifest = JSObject()
    for ((path, hash) in JGitEngine.listManifest(call.requireDir())) manifest.put(path, hash)
    JSObject().put("manifest", manifest)
  }

  @PluginMethod
  fun commitDelta(call: PluginCall) {
    val archive = call.getString("deltaArchiveBase64")
      ?: return call.reject("missing 'deltaArchiveBase64'")
    val message = call.getString("message") ?: "checkpoint"
    resolveAsync(call) {
      val arr = call.getArray("deletedPaths")
      val deleted = if (arr == null) emptyList() else (0 until arr.length()).map { arr.getString(it) }
      val expObj = call.getObject("expectedManifest")
      val expected = LinkedHashMap<String, String>()
      if (expObj != null) {
        val keys = expObj.keys()
        while (keys.hasNext()) {
          val k = keys.next()
          expObj.getString(k)?.let { expected[k] = it }
        }
      }
      val r = JGitEngine.commitDelta(call.requireDir(), archive, deleted, expected, message)
      r.detail?.let { android.util.Log.i("PushCheckpointDelta", "verify mismatch: $it") }
      JSObject()
        .put("committed", r.committed)
        .put("commitId", r.commitId ?: JSONObject.NULL)
        .put("treeId", r.treeId ?: JSONObject.NULL)
    }
  }
}
