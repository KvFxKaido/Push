package com.push.nativegit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.Date
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.eclipse.jgit.api.CreateBranchCommand
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.ResetCommand
import org.eclipse.jgit.diff.DiffFormatter
import org.eclipse.jgit.diff.RawTextComparator
import org.eclipse.jgit.dircache.DirCacheEntry
import org.eclipse.jgit.lib.BranchConfig
import org.eclipse.jgit.lib.BranchTrackingStatus
import org.eclipse.jgit.lib.CommitBuilder
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.FileMode
import org.eclipse.jgit.lib.ObjectId
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.lib.Ref
import org.eclipse.jgit.lib.Repository
import org.eclipse.jgit.revwalk.RevWalk
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.RefSpec
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import org.eclipse.jgit.treewalk.CanonicalTreeParser
import org.eclipse.jgit.treewalk.FileTreeIterator
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

  private const val DIFF_MAX_BYTES = 30 * 1024

  data class FileReadResult(
    val content: String,
    val truncated: Boolean,
    val totalLines: Int?,
    val error: String? = null,
    val code: String? = null,
  )
  data class FileWriteResult(val ok: Boolean, val bytesWritten: Int? = null, val error: String? = null)
  data class DirEntry(val name: String, val type: String, val size: Long?)
  data class ListDirResult(
    val entries: List<DirEntry>,
    val truncated: Boolean,
    val error: String? = null,
  )
  data class DiffResult(
    val diff: String,
    val truncated: Boolean,
    val gitStatus: String,
    val error: String? = null,
  )

  // -- Lifecycle --------------------------------------------------------------

  fun clone(url: String, dir: String, branch: String?, token: String?, depth: Int?) {
    val target = File(dir)
    if (target.exists() && File(target, ".git").exists()) {
      reconcileExistingClone(url, dir, branch, token, depth)
      return
    }
    val cmd = Git.cloneRepository().setURI(url).setDirectory(File(dir))
    if (!branch.isNullOrEmpty()) cmd.setBranch(branch)
    credentials(token)?.let { cmd.setCredentialsProvider(it) }
    if (depth != null && depth > 0) cmd.setDepth(depth)
    cmd.call().use { /* close the returned Git handle */ }
  }

  private fun reconcileExistingClone(url: String, dir: String, branch: String?, token: String?, depth: Int?) =
    withRepo(dir) { git ->
      val repo = git.repository
      val config = repo.config
      if (config.getString("remote", "origin", "url") != url) {
        config.setString("remote", "origin", "url", url)
        config.save()
      }

      val fetch = git.fetch().setRemote("origin")
      credentials(token)?.let { fetch.setCredentialsProvider(it) }
      if (depth != null && depth > 0) fetch.setDepth(depth)
      if (!branch.isNullOrEmpty()) {
        fetch.setRefSpecs(RefSpec("+refs/heads/$branch:refs/remotes/origin/$branch"))
      }
      fetch.call()

      // Data-loss guard: the TS working-copy registry is process-lifetime, so
      // after Android kills the app a resume re-invokes clone() on a dir that
      // may hold uncommitted edits or unpushed local commits. Only reset+clean
      // when it is provably safe — the working tree is clean AND HEAD has no
      // commits unreachable from the fetched origin ref. Otherwise keep local
      // state and reuse the clone as-is (still a success).
      if (!isResetSafe(git, branch)) {
        println("""{"level":"info","event":"native_git_reconcile_preserved","dir":${jsonString(dir)}}""")
        return@withRepo
      }

      if (!branch.isNullOrEmpty()) {
        val remoteRef = "refs/remotes/origin/$branch"
        if (repo.findRef("refs/heads/$branch") == null) {
          git.checkout()
            .setCreateBranch(true)
            .setName(branch)
            .setStartPoint(remoteRef)
            .setUpstreamMode(CreateBranchCommand.SetupUpstreamMode.TRACK)
            .call()
        } else {
          git.checkout().setName(branch).call()
        }
        git.reset().setMode(ResetCommand.ResetType.HARD).setRef(remoteRef).call()
      } else {
        val head = repo.resolve("refs/remotes/origin/HEAD") ?: repo.resolve("HEAD")
        if (head != null) {
          git.reset().setMode(ResetCommand.ResetType.HARD).setRef(head.name).call()
        }
      }
      git.clean().setCleanDirectories(true).setIgnore(false).call()
      println("""{"level":"info","event":"native_git_reconcile_reset","dir":${jsonString(dir)}}""")
    }

  /**
   * True when hard-resetting the reconciled clone to origin cannot lose local
   * work: the working tree is clean (isClean covers staged, unstaged, AND
   * untracked) and every HEAD commit is reachable from the fetched origin ref
   * (HEAD merged into origin ⇒ not ahead). An unborn HEAD has nothing to lose;
   * an unresolvable origin ref means safety can't be proven, so preserve.
   */
  private fun isResetSafe(git: Git, branch: String?): Boolean {
    if (!git.status().call().isClean) return false
    val repo = git.repository
    val originId = if (!branch.isNullOrEmpty()) {
      repo.resolve("refs/remotes/origin/$branch")
    } else {
      repo.resolve("refs/remotes/origin/HEAD")
    } ?: return false
    val headId = repo.resolve(Constants.HEAD) ?: return true
    return RevWalk(repo).use { walk ->
      walk.isMergedInto(walk.parseCommit(headId), walk.parseCommit(originId))
    }
  }

  private fun jsonString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

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
    formatPorcelain(git, git.status().call())
  }

  /** Porcelain-v1 formatting for an already-computed [status] on an open [git]. */
  private fun formatPorcelain(git: Git, status: org.eclipse.jgit.api.Status): String {
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
    return out.toString()
  }

  fun readFile(dir: String, path: String, startLine: Int?, endLine: Int?): FileReadResult {
    val root = File(dir)
    val file = safeChild(root, path)
      ?: return FileReadResult("", false, null, "path escapes working copy", "EACCES")
    if (!file.exists()) return FileReadResult("", false, null, "No such file: $path", "ENOENT")
    if (!file.isFile) return FileReadResult("", false, null, "Not a file: $path", "EISDIR")

    return try {
      val text = file.readText(Charsets.UTF_8)
      val lines = if (text.isEmpty()) emptyList() else text.split('\n')
      val totalLines = lines.size
      if (startLine == null && endLine == null) {
        FileReadResult(text, false, totalLines)
      } else {
        val start = (startLine ?: 1).coerceAtLeast(1)
        val end = (endLine ?: totalLines).coerceAtLeast(start)
        val selected =
          if (start > totalLines) emptyList() else lines.subList(start - 1, end.coerceAtMost(totalLines))
        FileReadResult(selected.joinToString("\n"), false, totalLines)
      }
    } catch (e: Exception) {
      FileReadResult("", false, null, e.message ?: "read failed", "EIO")
    }
  }

  fun writeFile(dir: String, path: String, content: String): FileWriteResult {
    val root = File(dir)
    val file = safeChild(root, path) ?: return FileWriteResult(false, null, "path escapes working copy")
    return try {
      file.parentFile?.mkdirs()
      file.writeText(content, Charsets.UTF_8)
      FileWriteResult(true, content.toByteArray(Charsets.UTF_8).size)
    } catch (e: Exception) {
      FileWriteResult(false, null, e.message ?: "write failed")
    }
  }

  fun listDir(dir: String, path: String?): ListDirResult {
    val root = File(dir)
    val target = safeChild(root, path ?: "")
      ?: return ListDirResult(emptyList(), false, "path escapes working copy")
    if (!target.exists()) return ListDirResult(emptyList(), false, "No such directory: ${path ?: ""}")
    if (!target.isDirectory) return ListDirResult(emptyList(), false, "Not a directory: ${path ?: ""}")

    val children = target.listFiles()?.sortedWith(compareBy<File> { !it.isDirectory }.thenBy { it.name })
      ?: emptyList()
    val limit = 500
    val entries = children.take(limit).map { child ->
      val type = when {
        java.nio.file.Files.isSymbolicLink(child.toPath()) -> "symlink"
        child.isDirectory -> "directory"
        child.isFile -> "file"
        else -> "other"
      }
      DirEntry(child.name, type, if (child.isFile) child.length() else null)
    }
    return ListDirResult(entries, children.size > limit)
  }

  fun diff(dir: String): DiffResult = withRepo(dir) { git ->
    try {
      val repo = git.repository
      val head = repo.resolve(Constants.HEAD + "^{tree}")
      val out = ByteArrayOutputStream()

      if (head != null) {
        repo.newObjectReader().use { reader ->
          val oldTree = CanonicalTreeParser().apply { reset(reader, head) }
          val newTree = FileTreeIterator(repo)
          // Note: with a working-tree iterator on side B, JGit's scan already
          // includes untracked non-ignored files as additions — do NOT render
          // untracked files separately or they appear twice.
          DiffFormatter(out).use { formatter ->
            formatter.setRepository(repo)
            formatter.setDiffComparator(RawTextComparator.DEFAULT)
            formatter.isDetectRenames = true
            for (entry in formatter.scan(oldTree, newTree)) {
              formatter.format(entry)
              if (out.size() > DIFF_MAX_BYTES) break
            }
          }
        }
      }

      val raw = out.toByteArray()
      val truncated = raw.size > DIFF_MAX_BYTES
      val diff = if (truncated) {
        String(raw.copyOf(DIFF_MAX_BYTES), Charsets.UTF_8) + "\n...(diff truncated at 30KB)"
      } else {
        String(raw, Charsets.UTF_8)
      }
      DiffResult(diff, truncated, formatPorcelain(git, git.status().call()))
    } catch (e: Exception) {
      DiffResult("", false, "", e.message ?: "diff failed")
    }
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
  /** Like [CheckpointCommit] but also carries the result tree id, so a delta
   *  caller can verify it against the sandbox's tree hash and fall back on drift. */
  data class CheckpointDelta(
    val committed: Boolean,
    val commitId: String?,
    val treeId: String?,
    val detail: String? = null,
  )
  data class CheckpointEntry(val commitId: String, val message: String, val timestampMs: Long)

  private const val CHECKPOINT_REF_PREFIX = "refs/checkpoints/"

  private fun ident() = PersonIdent("Push Checkpoint", "checkpoint@push.app")

  private fun isCheckpointRepo(dir: String): Boolean = File(File(dir), ".git").exists()

  private fun openOrInit(dir: String): Git {
    val f = File(dir)
    val git =
      if (File(f, ".git").exists()) {
        Git.open(f)
      } else {
        f.mkdirs()
        Git.init().setDirectory(f).call()
      }
    // Force RAW-BYTES blobs so the device's blob ids match the sandbox's manifest
    // (`git hash-object --no-filters`). `.git/info/attributes` has the HIGHEST
    // attribute precedence, so `* -text` disables text/EOL normalization for every
    // path — overriding any `.gitattributes` captured into the worktree (e.g. Push's
    // `* text=auto eol=lf` / `*.cmd eol=crlf`), which would otherwise make JGit
    // normalize content the sandbox hashed raw and fail every delta verify. Applied
    // on EXISTING repos too (idempotent) — checkpoints created before this predate it.
    val infoDir = File(f, ".git/info")
    infoDir.mkdirs()
    val attrs = File(infoDir, "attributes")
    if (!attrs.exists() || !attrs.readText().contains("* -text")) {
      attrs.writeText("* -text\n")
    }
    // autocrlf off too — belt-and-suspenders alongside info/attributes.
    git.repository.config.apply {
      setBoolean("core", null, "autocrlf", false)
      save()
    }
    return git
  }

  /** Checkpoint refs, newest commit first. */
  private fun checkpointRefsNewestFirst(git: Git): List<Ref> {
    val repo = git.repository
    val refs = repo.refDatabase.getRefsByPrefix(CHECKPOINT_REF_PREFIX)
    RevWalk(repo).use { walk ->
      return refs.sortedWith(
        compareByDescending<Ref> { checkpointRefTimestampMs(it) ?: walk.parseCommit(it.objectId).commitTime.toLong() * 1000L }
          .thenByDescending { it.objectId.name },
      )
    }
  }

  private fun checkpointRefTimestampMs(ref: Ref): Long? {
    val leaf = ref.name.removePrefix(CHECKPOINT_REF_PREFIX)
    val separator = leaf.indexOf('-')
    if (separator <= 0) return null
    return leaf.substring(0, separator).toLongOrNull()
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

  private data class WorktreeFile(val path: String, val file: File)

  private fun listWorktreeFiles(workTree: File): List<WorktreeFile> {
    val out = mutableListOf<WorktreeFile>()
    fun walk(dir: File) {
      val children = dir.listFiles() ?: return
      for (child in children) {
        if (child.name == ".git" && child.isDirectory) continue
        if (child.isDirectory) {
          walk(child)
        } else if (child.isFile) {
          val rel = workTree.toPath().relativize(child.toPath()).toString().replace(File.separatorChar, '/')
          out.add(WorktreeFile(rel, child))
        }
      }
    }
    walk(workTree)
    return out.sortedBy { it.path }
  }

  private fun clearStaleIndexLock(repo: Repository) {
    val lock = File(repo.directory, "index.lock")
    if (lock.exists() && !lock.delete()) {
      throw IllegalStateException("could not remove stale checkpoint index lock: ${lock.absolutePath}")
    }
  }

  /**
   * Rebuild the checkpoint repo index from the extracted archive worktree.
   *
   * Do not use JGit's AddCommand here: the captured tree can include `.gitignore`,
   * and those ignore rules belong to the source repo, not to the checkpoint repo's
   * staging decision. The sandbox has already chosen the capture set with
   * `git ls-files --cached --others --exclude-standard`; staging must preserve that
   * set exactly, including tracked files that match ignore patterns.
   */
  private fun stageWorktreeSnapshot(git: Git) {
    val repo = git.repository
    val files = listWorktreeFiles(repo.workTree)
    repo.newObjectInserter().use { inserter ->
      clearStaleIndexLock(repo)
      val cache = repo.lockDirCache()
      var committed = false
      try {
        val builder = cache.builder()
        for ((path, file) in files) {
          val entry = DirCacheEntry(path)
          entry.setFileMode(FileMode.REGULAR_FILE)
          entry.setLength(file.length())
          entry.setLastModified(Instant.ofEpochMilli(file.lastModified()))
          file.inputStream().use { input ->
            entry.setObjectId(inserter.insert(Constants.OBJ_BLOB, file.length(), input))
          }
          builder.add(entry)
        }
        inserter.flush()
        if (!builder.commit()) {
          throw IllegalStateException("could not commit checkpoint index")
        }
        committed = true
      } finally {
        if (!committed) cache.unlock()
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
      replaceWorktree(git.repository.workTree, archiveBase64)
      stageWorktreeSnapshot(git)
      val r = commitStagedTree(git, message)
      return CheckpointCommit(r.committed, r.commitId)
    }
  }

  /**
   * Write the staged index to a tree and create an orphan checkpoint commit + ref,
   * deduping against the newest existing checkpoint (identical tree → no new
   * commit, the existing ref is returned). Shared by [commitWorkingTree] (full
   * capture) and [commitDelta] (incremental); the returned `treeId` lets a delta
   * caller verify the result against the sandbox's tree hash.
   */
  private fun commitStagedTree(
    git: Git,
    message: String,
    expected: Map<String, String>? = null,
  ): CheckpointDelta {
    val repo = git.repository
    repo.newObjectInserter().use { inserter ->
      val treeId = repo.readDirCache().writeTree(inserter)
      inserter.flush()
      // Verify-BEFORE-publish: a delta caller passes the expected content manifest;
      // if the applied tree doesn't match (filter disagreement / drift), refuse
      // WITHOUT writing a ref, so an unverified checkpoint never lands (the caller
      // falls back to a full capture, which resets the worktree).
      if (expected != null) {
        val actual = treeManifest(repo, treeId)
        if (!manifestsEqual(actual, expected)) {
          return CheckpointDelta(false, null, treeId.name, manifestMismatchDetail(actual, expected))
        }
      }
      val newest = checkpointRefsNewestFirst(git).firstOrNull()
      if (newest != null) {
        RevWalk(repo).use { walk ->
          if (walk.parseCommit(newest.objectId).tree.name == treeId.name) {
            return CheckpointDelta(false, newest.objectId.name, treeId.name)
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
      val update = repo.updateRef(CHECKPOINT_REF_PREFIX + "${System.currentTimeMillis()}-${commitId.name}")
      update.setNewObjectId(commitId)
      update.setForceUpdate(true)
      update.update()
      return CheckpointDelta(true, commitId.name, treeId.name)
    }
  }

  private fun archiveCommit(repo: Repository, commitId: ObjectId): String? {
    RevWalk(repo).use { walk ->
      val commit = try { walk.parseCommit(commitId) } catch (e: Exception) { return null }
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

  /** A checkpoint commit's tree as a base64 ZIP, or null when the repo/commit is absent. */
  fun archiveCommit(dir: String, commitId: String): String? {
    if (!isCheckpointRepo(dir) || commitId.isEmpty()) return null
    Git.open(File(dir)).use { git ->
      val repo = git.repository
      val id = try { ObjectId.fromString(commitId) } catch (e: Exception) { return null }
      return archiveCommit(repo, id)
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

  /**
   * Delete the single checkpoint whose commit is [commitId] (its ref, or refs if
   * more than one points at it), then gc the now-unreferenced objects so the
   * dropped content isn't recoverable from the object store. Returns true when a
   * ref was removed; false on an unknown/invalid commit (a no-op).
   */
  fun dropCheckpoint(dir: String, commitId: String): Boolean {
    if (!isCheckpointRepo(dir) || commitId.isEmpty()) return false
    val target = try { ObjectId.fromString(commitId) } catch (e: Exception) { return false }
    Git.open(File(dir)).use { git ->
      val refs =
        git.repository.refDatabase.getRefsByPrefix(CHECKPOINT_REF_PREFIX).filter {
          it.objectId == target
        }
      if (refs.isEmpty()) return false
      for (ref in refs) {
        val update = git.repository.updateRef(ref.name)
        update.setForceUpdate(true)
        update.delete()
      }
      git.gc().setExpire(Date()).call()
      return true
    }
  }

  /**
   * Securely purge the checkpoint repo at [dir] by deleting the directory OUTRIGHT
   * — no surviving `.git` objects, packs, or reflogs. A ref-delete + gc (as prune
   * does) can leave packed objects recoverable; a full directory delete cannot,
   * which is the point of the security mitigation (#1103). The next capture
   * re-`git init`s the dir via [openOrInit]. Either a single lane dir or the whole
   * `checkpoints` root may be passed. Returns true when the dir existed and was
   * removed (a missing dir is a no-op false).
   */
  fun clearCheckpoints(dir: String): Boolean {
    val f = File(dir)
    if (!f.exists()) return false
    // A partial/failed delete must NOT read as a no-op — that would report a
    // security purge as successful while checkpoint files (secrets) remain on
    // disk. `deleteRecursively()` returns false on any failure; re-check the dir
    // is actually gone and throw otherwise, so the caller surfaces a real error.
    val deleted = f.deleteRecursively()
    if (!deleted || f.exists()) {
      throw IllegalStateException("checkpoint dir not fully removed: $dir")
    }
    return true
  }

  /**
   * Content-only manifest (`path → blob SHA-1`) of the NEWEST checkpoint ref's
   * tree — the base a diff capture diffs against. NOT HEAD: checkpoints are orphan
   * refs and HEAD never moves. Blob ids are content hashes (mode excluded), which
   * is exactly what the sandbox's raw-bytes manifest must agree with. Empty map
   * when there is no checkpoint yet (the caller then full-captures).
   */
  fun listManifest(dir: String): Map<String, String> {
    if (!isCheckpointRepo(dir)) return emptyMap()
    Git.open(File(dir)).use { git ->
      val repo = git.repository
      val newest = checkpointRefsNewestFirst(git).firstOrNull() ?: return emptyMap()
      RevWalk(repo).use { walk -> return treeManifest(repo, walk.parseCommit(newest.objectId).tree) }
    }
  }

  /** Content-only manifest (`path → blob SHA-1`, mode excluded) of a tree. */
  private fun treeManifest(repo: Repository, tree: ObjectId): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    TreeWalk(repo).use { tw ->
      tw.addTree(tree)
      tw.isRecursive = true
      while (tw.next()) out[tw.pathString] = tw.getObjectId(0).name
    }
    return out
  }

  /** Content equality of two `path → sha` manifests (mode excluded). */
  private fun manifestsEqual(a: Map<String, String>, b: Map<String, String>): Boolean =
    a.size == b.size && a.all { (k, v) -> b[k] == v }

  /** Diagnostic summary of why two manifests differ (counts + sample paths). */
  private fun manifestMismatchDetail(actual: Map<String, String>, expected: Map<String, String>): String {
    val onlyActual = actual.keys.filter { it !in expected }.take(6)
    val onlyExpected = expected.keys.filter { it !in actual }.take(6)
    val valDiff = actual.keys.filter { it in expected && actual[it] != expected[it] }.take(6)
    return "actual=${actual.size} expected=${expected.size}" +
      " onlyActual=$onlyActual onlyExpected=$onlyExpected valDiff=$valDiff"
  }

  /** Resolve [rel] under [workTree], returning null if it would escape the tree. */
  private fun safeChild(workTree: File, rel: String): File? {
    val child = File(workTree, rel)
    val base = workTree.canonicalPath
    val cp = child.canonicalPath
    if (cp != base && !cp.startsWith(base + File.separator)) return null
    return child
  }

  /**
   * Extract a delta ZIP onto [workTree] WITHOUT clearing it, handling dir↔file
   * transitions (the full path leans on a clear-first; a delta can't): a leaf
   * arriving as the wrong type replaces whatever occupies its path.
   */
  private fun extractDeltaOnto(workTree: File, archiveBase64: String) {
    val base = workTree.canonicalPath
    ZipInputStream(ByteArrayInputStream(Base64.getDecoder().decode(archiveBase64))).use { zis ->
      var entry: ZipEntry? = zis.nextEntry
      while (entry != null) {
        val out = File(workTree, entry.name)
        if (out.canonicalPath != base && !out.canonicalPath.startsWith(base + File.separator)) {
          throw IllegalStateException("zip entry escapes target: ${entry.name}")
        }
        if (entry.isDirectory) {
          if (out.isFile) out.delete() // file → dir
          out.mkdirs()
        } else {
          if (out.isDirectory) out.deleteRecursively() // dir → file
          out.parentFile?.mkdirs()
          out.outputStream().use { zis.copyTo(it) }
        }
        entry = zis.nextEntry
      }
    }
  }

  /**
   * Apply a capture DELTA onto the newest checkpoint tree and commit an orphan
   * checkpoint — same result tree as a full capture, a fraction of the bytes. The
   * newest checkpoint is restored into a clean worktree first so residue from a
   * prior failed verify cannot poison the next delta. [deletedPaths] are removed
   * FIRST so a dir↔file swap at one path lands cleanly, then
   * [deltaArchiveBase64]'s changed/new files are extracted over the tree. The
   * applied tree is verified against [expectedManifest] (the sandbox's
   * current content manifest) BEFORE any ref is written, so a wrong delta never
   * publishes a checkpoint. Returns `committed=false` with a null commitId when
   * there's no base, when verification fails, or when applying threw — the caller
   * full-captures in every such case; `committed=false` with the existing commitId
   * means the delta de-duped to the newest checkpoint (no change).
   */
  fun commitDelta(
    dir: String,
    deltaArchiveBase64: String,
    deletedPaths: List<String>,
    expectedManifest: Map<String, String>,
    message: String,
  ): CheckpointDelta {
    if (!isCheckpointRepo(dir)) return CheckpointDelta(false, null, null)
    openOrInit(dir).use { git ->
      val newest = checkpointRefsNewestFirst(git).firstOrNull() ?: return CheckpointDelta(false, null, null)
      val workTree = git.repository.workTree
      val baseArchive = archiveCommit(git.repository, newest.objectId) ?: return CheckpointDelta(false, null, null)
      replaceWorktree(workTree, baseArchive)
      for (rel in deletedPaths) safeChild(workTree, rel)?.deleteRecursively()
      extractDeltaOnto(workTree, deltaArchiveBase64)
      stageWorktreeSnapshot(git)
      return commitStagedTree(git, message, expectedManifest)
    }
  }
}
