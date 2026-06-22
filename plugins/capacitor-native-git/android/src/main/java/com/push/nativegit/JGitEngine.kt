package com.push.nativegit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.Date
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.lib.BranchConfig
import org.eclipse.jgit.lib.BranchTrackingStatus
import org.eclipse.jgit.lib.CommitBuilder
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.ObjectId
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.Ref
import org.eclipse.jgit.revwalk.RevWalk
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import org.eclipse.jgit.treewalk.TreeWalk

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

  // -- Checkpoints (CheckpointStore native backend) ---------------------------
  // Checkpoints are ORPHAN commits (no parents) under refs/checkpoints/<sha>, in
  // an app-private repo separate from any session working copy. Orphan refs make
  // retention a trivial ref-delete + gc (no history rewrite); git still
  // delta-packs the similar trees, and `git diff <a> <b>` works across them.

  data class CheckpointCommit(val committed: Boolean, val commitId: String?)
  data class CheckpointEntry(val commitId: String, val message: String, val timestampMs: Long)

  private const val CHECKPOINT_REF_PREFIX = "refs/checkpoints/"

  private fun ident() = PersonIdent("Push Checkpoint", "checkpoint@push.app")

  private fun isCheckpointRepo(dir: String): Boolean = File(File(dir), ".git").exists()

  private fun openOrInit(dir: String): Git {
    val f = File(dir)
    if (File(f, ".git").exists()) return Git.open(f)
    f.mkdirs()
    return Git.init().setDirectory(f).call()
  }

  /** Checkpoint refs, newest commit first. */
  private fun checkpointRefsNewestFirst(git: Git): List<Ref> {
    val repo = git.repository
    val refs = repo.refDatabase.getRefsByPrefix(CHECKPOINT_REF_PREFIX)
    RevWalk(repo).use { walk ->
      return refs.sortedByDescending { walk.parseCommit(it.objectId).commitTime }
    }
  }

  /** Clear [workTree] (keeping `.git`) and extract a base64 ZIP into it. */
  private fun replaceWorktree(workTree: File, archiveBase64: String) {
    workTree.listFiles()?.forEach { if (it.name != ".git") it.deleteRecursively() }
    val base = workTree.canonicalPath
    ZipInputStream(ByteArrayInputStream(Base64.getDecoder().decode(archiveBase64))).use { zis ->
      var entry: ZipEntry? = zis.nextEntry
      while (entry != null) {
        val out = File(workTree, entry.name)
        // Path-traversal guard — a malicious entry must not escape the worktree.
        if (out.canonicalPath != base && !out.canonicalPath.startsWith(base + File.separator)) {
          throw IllegalStateException("zip entry escapes target: ${entry.name}")
        }
        if (entry.isDirectory) {
          out.mkdirs()
        } else {
          out.parentFile?.mkdirs()
          out.outputStream().use { zis.copyTo(it) }
        }
        entry = zis.nextEntry
      }
    }
  }

  /**
   * Extract [archiveBase64] into `dir`'s worktree, stage it (additions +
   * deletions), and create an orphan checkpoint commit. `committed` is false when
   * the tree is identical to the newest existing checkpoint (no new commit/ref).
   */
  fun commitWorkingTree(dir: String, archiveBase64: String, message: String): CheckpointCommit {
    openOrInit(dir).use { git ->
      val repo = git.repository
      replaceWorktree(repo.workTree, archiveBase64)
      git.add().addFilepattern(".").call()
      git.add().setUpdate(true).addFilepattern(".").call()
      repo.newObjectInserter().use { inserter ->
        val treeId = repo.readDirCache().writeTree(inserter)
        inserter.flush()
        val newest = checkpointRefsNewestFirst(git).firstOrNull()
        if (newest != null) {
          RevWalk(repo).use { walk ->
            if (walk.parseCommit(newest.objectId).tree.name == treeId.name) {
              return CheckpointCommit(false, newest.objectId.name)
            }
          }
        }
        val builder = CommitBuilder().apply {
          setTreeId(treeId)
          author = ident()
          committer = ident()
          setMessage(message)
        }
        val commitId = inserter.insert(builder)
        inserter.flush()
        val update = repo.updateRef(CHECKPOINT_REF_PREFIX + commitId.name)
        update.setNewObjectId(commitId)
        update.setForceUpdate(true)
        update.update()
        return CheckpointCommit(true, commitId.name)
      }
    }
  }

  /** A checkpoint commit's tree as a base64 ZIP, or null when the repo/commit is absent. */
  fun archiveCommit(dir: String, commitId: String): String? {
    if (!isCheckpointRepo(dir) || commitId.isEmpty()) return null
    Git.open(File(dir)).use { git ->
      val repo = git.repository
      val id = try { ObjectId.fromString(commitId) } catch (e: Exception) { return null }
      RevWalk(repo).use { walk ->
        val commit = try { walk.parseCommit(id) } catch (e: Exception) { return null }
        val baos = ByteArrayOutputStream()
        ZipOutputStream(baos).use { zos ->
          TreeWalk(repo).use { tw ->
            tw.addTree(commit.tree)
            tw.isRecursive = true
            while (tw.next()) {
              zos.putNextEntry(ZipEntry(tw.pathString))
              repo.open(tw.getObjectId(0)).copyTo(zos)
              zos.closeEntry()
            }
          }
        }
        return Base64.getEncoder().encodeToString(baos.toByteArray())
      }
    }
  }

  /** Checkpoint history, newest first. */
  fun listCheckpoints(dir: String): List<CheckpointEntry> {
    if (!isCheckpointRepo(dir)) return emptyList()
    Git.open(File(dir)).use { git ->
      val repo = git.repository
      RevWalk(repo).use { walk ->
        return checkpointRefsNewestFirst(git).map { ref ->
          val c = walk.parseCommit(ref.objectId)
          CheckpointEntry(c.name, c.fullMessage.trim(), c.commitTime.toLong() * 1000L)
        }
      }
    }
  }

  /** Keep the newest [keep] checkpoints; delete older refs and gc the objects. */
  fun pruneCheckpoints(dir: String, keep: Int): Int {
    if (!isCheckpointRepo(dir)) return 0
    Git.open(File(dir)).use { git ->
      val refs = checkpointRefsNewestFirst(git)
      val drop = refs.drop(keep.coerceAtLeast(0))
      if (drop.isEmpty()) return 0
      for (ref in drop) {
        val update = git.repository.updateRef(ref.name)
        update.setForceUpdate(true)
        update.delete()
      }
      // Prune the now-unreferenced orphan commit objects (older than "now" = all).
      git.gc().setExpire(Date()).call()
      return drop.size
    }
  }
}
