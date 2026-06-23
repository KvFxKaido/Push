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
   */
  private fun resolveDir(dir: String): String =
    if (File(dir).isAbsolute) dir else File(getContext().filesDir, dir).absolutePath

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
      val r = JGitEngine.commitDelta(call.requireDir(), archive, deleted, message)
      JSObject()
        .put("committed", r.committed)
        .put("commitId", r.commitId ?: JSONObject.NULL)
        .put("treeId", r.treeId ?: JSONObject.NULL)
    }
  }
}
