package com.push.nativegit

import java.io.File
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.lib.BranchConfig
import org.eclipse.jgit.lib.BranchTrackingStatus
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.ObjectId
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider

/**
 * The on-device git engine: thin, typed wrappers over JGit. The Capacitor
 * bridge ([NativeGitPlugin]) parses the JS call, dispatches here off the main
 * thread, and shapes the return. Reads throw on failure (the TS backend maps a
 * thrown bridge error to null); writes are invoked through [tryWrite] so an
 * ordinary git failure (e.g. "nothing to commit") becomes a structured
 * `{ ok:false, message }` rather than an exception.
 *
 * Auth: GitHub HTTPS accepts a PAT/installation token as the password with any
 * username; we use "x-access-token" (the GitHub Apps convention). The token is
 * received per call and never persisted — the credentials provider lives only
 * for the duration of the operation.
 */
object JGitEngine {

  private fun credentials(token: String?): CredentialsProvider? =
    token?.takeIf { it.isNotEmpty() }?.let {
      UsernamePasswordCredentialsProvider("x-access-token", it)
    }

  private fun <T> withRepo(dir: String, block: (Git) -> T): T =
    Git.open(File(dir)).use(block)

  // -- Lifecycle --------------------------------------------------------------

  fun clone(url: String, dir: String, branch: String?, token: String?, depth: Int?) {
    val cmd = Git.cloneRepository().setURI(url).setDirectory(File(dir))
    if (!branch.isNullOrEmpty()) cmd.setBranch(branch)
    credentials(token)?.let { cmd.setCredentialsProvider(it) }
    if (depth != null && depth > 0) cmd.setDepth(depth)
    cmd.call().use { /* close the returned Git handle */ }
  }

  // -- Reads ------------------------------------------------------------------

  /** Branch short-name, or null when detached. */
  fun currentBranch(dir: String): String? = withRepo(dir) { git ->
    val repo = git.repository
    val head = repo.exactRef(Constants.HEAD) ?: return@withRepo null
    if (head.isSymbolic) repo.branch else null
  }

  /** Upstream ref as `origin/<branch>`, or null when no tracking branch is set. */
  fun upstreamRef(dir: String): String? = withRepo(dir) { git ->
    val repo = git.repository
    val branch = repo.branch ?: return@withRepo null
    // getTrackingBranch() is the full remote-tracking ref, e.g.
    // refs/remotes/origin/feature/x; normalize to the `origin/feature/x` form
    // git's `rev-parse --abbrev-ref @{u}` prints.
    val tracking = BranchConfig(repo.config, branch).trackingBranch ?: return@withRepo null
    tracking.removePrefix("refs/remotes/")
  }

  /** Resolved URL for a remote (push URL when [push]), or null when unset. */
  fun remoteUrl(dir: String, remote: String, push: Boolean): String? = withRepo(dir) { git ->
    val config = git.repository.config
    val key = if (push) "pushurl" else "url"
    config.getString("remote", remote, key)
      ?: config.getString("remote", remote, "url") // pushurl falls back to url
  }

  /** HEAD sha (abbreviated to 7 when [short]), or null when unborn/unreadable. */
  fun headSha(dir: String, short: Boolean): String? = withRepo(dir) { git ->
    val id: ObjectId = git.repository.resolve(Constants.HEAD) ?: return@withRepo null
    if (short) id.name.substring(0, 7) else id.name
  }

  /**
   * Working-tree status as porcelain v1 with a branch header
   * (`git status --porcelain -b`). Emitting the exact text the TS side already
   * parses (`parseGitStatusInfo`) is deliberate: the native status can't drift
   * from the sandbox/CLI status because it goes through the same parser.
   */
  fun statusPorcelain(dir: String): String = withRepo(dir) { git ->
    val repo = git.repository
    val out = StringBuilder()
    val branch = repo.branch

    out.append("## ")
    if (branch == null) {
      out.append("HEAD (no branch)")
    } else {
      out.append(branch)
      val tracking = BranchConfig(repo.config, branch).trackingBranch
      if (tracking != null) {
        out.append("...").append(tracking.removePrefix("refs/remotes/"))
        val ab = BranchTrackingStatus.of(repo, branch)
        if (ab != null && (ab.aheadCount > 0 || ab.behindCount > 0)) {
          val parts = mutableListOf<String>()
          if (ab.aheadCount > 0) parts.add("ahead ${ab.aheadCount}")
          if (ab.behindCount > 0) parts.add("behind ${ab.behindCount}")
          out.append(" [").append(parts.joinToString(", ")).append("]")
        }
      }
    }
    out.append("\n")

    // Merge JGit's per-category sets into porcelain XY columns (X=index/staged,
    // Y=worktree/unstaged). Untracked are emitted as `??` after the tracked
    // entries, matching git's ordering closely enough for the parser.
    val status = git.status().call()
    val xy = sortedMapOf<String, CharArray>()
    fun mark(path: String, x: Char?, y: Char?) {
      val cell = xy.getOrPut(path) { charArrayOf(' ', ' ') }
      if (x != null) cell[0] = x
      if (y != null) cell[1] = y
    }
    status.added.forEach { mark(it, 'A', null) }
    status.changed.forEach { mark(it, 'M', null) }
    status.removed.forEach { mark(it, 'D', null) }
    status.modified.forEach { mark(it, null, 'M') }
    status.missing.forEach { mark(it, null, 'D') }
    status.conflicting.forEach { mark(it, 'U', 'U') }

    for ((path, cell) in xy) out.append(cell[0]).append(cell[1]).append(' ').append(path).append("\n")
    status.untracked.sorted().forEach { out.append("?? ").append(it).append("\n") }
    out.toString()
  }

  // -- Writes (throw on failure; the bridge maps to { ok:false, message }) ----

  fun createBranch(dir: String, name: String, from: String?) = withRepo(dir) { git ->
    val cmd = git.checkout().setCreateBranch(true).setName(name)
    if (!from.isNullOrEmpty()) cmd.setStartPoint(from)
    cmd.call()
  }

  fun switchBranch(dir: String, branch: String) = withRepo(dir) { git ->
    git.checkout().setName(branch).call()
  }

  fun commit(dir: String, message: String, addAll: Boolean) = withRepo(dir) { git ->
    if (addAll) {
      // addFilepattern(".") stages new + modified; setUpdate(true) is the
      // second pass that records deletions (AddCommand alone won't stage a
      // removed file). Together they approximate `git add -A`.
      git.add().addFilepattern(".").call()
      git.add().setUpdate(true).addFilepattern(".").call()
    }
    git.commit().setMessage(message).call()
  }

  fun push(dir: String, remote: String, ref: String, setUpstream: Boolean, token: String?) =
    withRepo(dir) { git ->
      val cmd = git.push().setRemote(remote).setRefSpecs(RefSpec(ref))
      credentials(token)?.let { cmd.setCredentialsProvider(it) }
      val results = cmd.call()
      // JGit reports per-ref rejections in the result rather than throwing;
      // surface the first non-OK update as a failure the bridge can report.
      for (result in results) {
        for (update in result.remoteUpdates) {
          val ok = update.status == org.eclipse.jgit.transport.RemoteRefUpdate.Status.OK ||
            update.status == org.eclipse.jgit.transport.RemoteRefUpdate.Status.UP_TO_DATE
          if (!ok) {
            throw IllegalStateException(
              "push rejected (${update.status}): ${update.message ?: update.remoteName}",
            )
          }
        }
      }
      if (setUpstream) {
        val branch = git.repository.branch
        if (branch != null) {
          val config = git.repository.config
          config.setString("branch", branch, "remote", remote)
          config.setString("branch", branch, "merge", "refs/heads/$branch")
          config.save()
        }
      }
    }

  fun fetch(dir: String, remote: String, refspec: String?, depth: Int?, token: String?) =
    withRepo(dir) { git ->
      val cmd = git.fetch().setRemote(remote)
      if (!refspec.isNullOrEmpty()) cmd.setRefSpecs(RefSpec(refspec))
      if (depth != null && depth > 0) cmd.setDepth(depth)
      credentials(token)?.let { cmd.setCredentialsProvider(it) }
      cmd.call()
    }
}
