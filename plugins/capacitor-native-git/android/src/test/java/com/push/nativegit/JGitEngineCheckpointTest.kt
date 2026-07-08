package com.push.nativegit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.ObjectInserter
import org.eclipse.jgit.lib.PersonIdent

/**
 * Host-JVM tests for the checkpoint engine. The checkpoint methods use only JGit
 * + java.util.zip + java.io (no android.* APIs), so the real logic runs here;
 * the Android APK build proves it also links/desugars on-device.
 */
class JGitEngineCheckpointTest {

  private fun zipOf(files: Map<String, String>): String {
    val baos = ByteArrayOutputStream()
    ZipOutputStream(baos).use { z ->
      files.forEach { (path, content) ->
        z.putNextEntry(ZipEntry(path))
        z.write(content.toByteArray())
        z.closeEntry()
      }
    }
    return Base64.getEncoder().encodeToString(baos.toByteArray())
  }

  private fun unzip(base64: String): Map<String, String> {
    val out = mutableMapOf<String, String>()
    ZipInputStream(ByteArrayInputStream(Base64.getDecoder().decode(base64))).use { zis ->
      var entry: ZipEntry? = zis.nextEntry
      while (entry != null) {
        if (!entry.isDirectory) out[entry.name] = zis.readBytes().toString(Charsets.UTF_8)
        entry = zis.nextEntry
      }
    }
    return out
  }

  private fun tempDir(): String = Files.createTempDirectory("push-cp-test").toFile().absolutePath

  private fun commitAll(git: Git, message: String) {
    git.add().addFilepattern(".").call()
    git.commit()
      .setMessage(message)
      .setAuthor(PersonIdent("Push Test", "test@push.local"))
      .setCommitter(PersonIdent("Push Test", "test@push.local"))
      .call()
  }

  /** Git blob SHA-1 of raw content — the expected-manifest value commitDelta verifies. */
  private fun blobSha(content: String): String =
    ObjectInserter.Formatter().idFor(Constants.OBJ_BLOB, content.toByteArray()).name

  @Test
  fun captureCommitsAndDedupsIdenticalTrees() {
    val dir = tempDir()
    val r1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "one", "sub/b.txt" to "two")), "cp1")
    assertTrue("first capture commits", r1.committed)
    assertNotNull(r1.commitId)

    // Identical tree → no new commit.
    val r2 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "one", "sub/b.txt" to "two")), "cp2")
    assertFalse("identical tree is unchanged", r2.committed)
    assertEquals(r1.commitId, r2.commitId)
    assertEquals(1, JGitEngine.listCheckpoints(dir).size)
  }

  @Test
  fun workspaceFileOpsAreScopedAndSupportLineRanges() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()

    val write = JGitEngine.writeFile(dir, "src/a.txt", "one\ntwo\nthree")
    assertTrue(write.ok)
    assertEquals(13, write.bytesWritten)

    val read = JGitEngine.readFile(dir, "src/a.txt", 2, 3)
    assertNull(read.error)
    assertEquals("two\nthree", read.content)
    assertEquals(3, read.totalLines)

    val listed = JGitEngine.listDir(dir, "src")
    assertNull(listed.error)
    assertEquals(listOf("a.txt"), listed.entries.map { it.name })

    val escaped = JGitEngine.writeFile(dir, "../outside.txt", "nope")
    assertFalse("native side rejects traversal that escapes the clone", escaped.ok)
  }

  /**
   * A file guaranteed to exceed READ_MAX_CHARS: `lineCount` lines of exactly
   * 49 chars + '\n'. Written straight to disk (no git checkout involved), so
   * host autocrlf can't smudge the content.
   */
  private fun writeBigFile(dir: String, lineCount: Int): List<String> {
    val lines = (1..lineCount).map { "line-%05d-".format(it) + "x".repeat(38) }
    File(dir, "big.txt").writeText(lines.joinToString("\n"))
    return lines
  }

  @Test
  fun unboundedReadOfLargeFileIsCappedAtLineBoundaryWithFullLineCount() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()
    val lineCount = 5000 // 5000 * 50 chars = 250k > READ_MAX_CHARS (200k)
    val lines = writeBigFile(dir, lineCount)

    val read = JGitEngine.readFile(dir, "big.txt", null, null)
    assertNull(read.error)
    assertTrue("capped read reports truncation", read.truncated)
    assertEquals("totalLines counts the FULL file, not the capped slice", lineCount, read.totalLines)
    assertTrue("content respects the cap", read.content.length <= JGitEngine.READ_MAX_CHARS)

    // Truncation lands on a line boundary: the content is exactly the longest
    // whole-line prefix that fits under the cap.
    val expected = StringBuilder()
    for (line in lines) {
      val sep = if (expected.isEmpty()) 0 else 1
      if (expected.length + sep + line.length > JGitEngine.READ_MAX_CHARS) break
      if (sep == 1) expected.append('\n')
      expected.append(line)
    }
    assertEquals(expected.toString(), read.content)
  }

  @Test
  fun rangeReadBeyondTheCapBoundaryStillServesTheRequestedLines() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()
    val lines = writeBigFile(dir, 5000)

    // Lines near EOF — far past where the unbounded read gets capped.
    val read = JGitEngine.readFile(dir, "big.txt", 4990, 4995)
    assertNull(read.error)
    assertFalse("an in-cap range is not truncated", read.truncated)
    assertEquals(5000, read.totalLines)
    assertEquals(lines.subList(4989, 4995).joinToString("\n"), read.content)
  }

  @Test
  fun singleRangeExceedingTheCapIsItselfCapped() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()
    writeBigFile(dir, 5000)

    val read = JGitEngine.readFile(dir, "big.txt", 1, 5000)
    assertNull(read.error)
    assertTrue("a range wider than the cap truncates", read.truncated)
    assertEquals(5000, read.totalLines)
    assertTrue(read.content.length <= JGitEngine.READ_MAX_CHARS)
  }

  @Test
  fun singleOversizedLineIsHardCutWithoutMaterializing() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()
    File(dir, "one-line.txt").writeText("y".repeat(JGitEngine.READ_MAX_CHARS + 50_000))

    val read = JGitEngine.readFile(dir, "one-line.txt", null, null)
    assertNull(read.error)
    assertTrue(read.truncated)
    assertEquals(1, read.totalLines)
    assertEquals(JGitEngine.READ_MAX_CHARS, read.content.length)
  }

  @Test
  fun smallFileReadIsUnchangedByTheCap() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().close()
    JGitEngine.writeFile(dir, "small.txt", "one\ntwo\nthree")

    val read = JGitEngine.readFile(dir, "small.txt", null, null)
    assertNull(read.error)
    assertFalse(read.truncated)
    assertEquals("one\ntwo\nthree", read.content)
    assertEquals(3, read.totalLines)
  }

  @Test
  fun workspaceDiffIncludesTrackedAndUntrackedChanges() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().use { git ->
      File(dir, "a.txt").writeText("one\n")
      commitAll(git, "initial")
    }

    File(dir, "a.txt").writeText("two\n")
    File(dir, "b.txt").writeText("new\n")
    val diff = JGitEngine.diff(dir)

    assertNull(diff.error)
    assertTrue(diff.diff.contains("diff --git"))
    assertTrue(diff.diff.contains("+two"))
    assertTrue(diff.diff.contains("new file mode 100644"))
    assertTrue(diff.gitStatus.contains(" M a.txt"))
    assertTrue(diff.gitStatus.contains("?? b.txt"))
  }

  @Test
  fun workspaceDiffDoesNotDuplicateUntrackedFiles() {
    val dir = tempDir()
    Git.init().setDirectory(File(dir)).call().use { git ->
      File(dir, "a.txt").writeText("one\n")
      commitAll(git, "initial")
    }

    File(dir, "b.txt").writeText("new\n")
    val diff = JGitEngine.diff(dir)

    assertNull(diff.error)
    val header = "diff --git a/b.txt b/b.txt"
    val occurrences = Regex(Regex.escape(header)).findAll(diff.diff).count()
    assertEquals("untracked file appears exactly once in the diff", 1, occurrences)
    assertEquals("its content appears exactly once", 1, Regex(Regex.escape("+new")).findAll(diff.diff).count())
  }

  /**
   * Remote with one commit on `main`, plus a fresh clone of it. Returns
   * (remote, clone). File content deliberately carries NO newline: a host
   * `core.autocrlf=true` (common on Windows) would smudge checked-out LFs to
   * CRLF and break exact-content asserts.
   */
  private fun remoteAndClone(): Pair<String, String> {
    val remote = tempDir()
    Git.init().setDirectory(File(remote)).call().use { git ->
      File(remote, "a.txt").writeText("one")
      commitAll(git, "one")
      git.branchCreate().setName("main").call()
      git.checkout().setName("main").call()
    }
    val clone = tempDir()
    File(clone).deleteRecursively()
    JGitEngine.clone(File(remote).toURI().toString(), clone, "main", null, null)
    assertEquals("one", File(clone, "a.txt").readText())
    return remote to clone
  }

  private fun advanceRemote(remote: String) {
    Git.open(File(remote)).use { git ->
      File(remote, "a.txt").writeText("two")
      commitAll(git, "two")
    }
  }

  @Test
  fun cloneReconcilesCleanExistingRepoByFetchResetInsteadOfRecloning() {
    val (remote, clone) = remoteAndClone()
    advanceRemote(remote)

    // Clean, not ahead of origin: reconciliation may safely reset to origin/main.
    JGitEngine.clone(File(remote).toURI().toString(), clone, "main", null, null)

    assertEquals("two", File(clone, "a.txt").readText())
  }

  @Test
  fun cloneReconcilePreservesDirtyWorkingTree() {
    val (remote, clone) = remoteAndClone()
    advanceRemote(remote)

    File(clone, "a.txt").writeText("local dirty edit")
    File(clone, "scratch.txt").writeText("keep me")

    // App-restart resume path: clone() on the existing dir must not destroy
    // uncommitted edits or untracked files.
    JGitEngine.clone(File(remote).toURI().toString(), clone, "main", null, null)

    assertEquals("local dirty edit", File(clone, "a.txt").readText())
    assertTrue("untracked file survives reconciliation", File(clone, "scratch.txt").exists())
    assertEquals("keep me", File(clone, "scratch.txt").readText())
  }

  @Test
  fun cloneReconcilePreservesLocalCommitsAheadOfOrigin() {
    val (remote, clone) = remoteAndClone()

    Git.open(File(clone)).use { git ->
      File(clone, "a.txt").writeText("local commit")
      commitAll(git, "unpushed local work")
    }
    val localHead = JGitEngine.headSha(clone, false)
    assertNotNull(localHead)

    JGitEngine.clone(File(remote).toURI().toString(), clone, "main", null, null)

    assertEquals("unpushed local commit stays HEAD", localHead, JGitEngine.headSha(clone, false))
    assertEquals("local commit", File(clone, "a.txt").readText())
  }

  @Test
  fun captureIsDeleteFaithfulAndArchiveRoundTrips() {
    val dir = tempDir()
    val r1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "one", "sub/b.txt" to "two")), "cp1")
    // cp2 drops sub/b.txt and edits a.txt.
    val r2 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "ONE")), "cp2")
    assertTrue(r2.committed)

    val first = unzip(JGitEngine.archiveCommit(dir, r1.commitId!!)!!)
    assertEquals("one", first["a.txt"])
    assertEquals("two", first["sub/b.txt"])

    val second = unzip(JGitEngine.archiveCommit(dir, r2.commitId!!)!!)
    assertEquals("ONE", second["a.txt"])
    assertNull("deletion is faithful — b.txt is gone in cp2", second["sub/b.txt"])
  }

  @Test
  fun listIsNewestFirstAndPruneEnforcesTheCap() {
    val dir = tempDir()
    val c1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("f" to "1")), "cp1").commitId
    Thread.sleep(5) // New refs carry millisecond order; no full-second pause needed.
    val c2 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("f" to "2")), "cp2").commitId

    val list = JGitEngine.listCheckpoints(dir)
    assertEquals(2, list.size)
    assertEquals("newest first", c2, list[0].commitId)
    assertEquals(c1, list[1].commitId)

    val pruned = JGitEngine.pruneCheckpoints(dir, 1)
    assertEquals(1, pruned)
    val remaining = JGitEngine.listCheckpoints(dir)
    assertEquals(1, remaining.size)
    assertEquals("the newest survives the cap", c2, remaining[0].commitId)
  }

  @Test
  fun dropCheckpointRemovesOnlyTheTargetedEntry() {
    val dir = tempDir()
    val c1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("f" to "1")), "cp1").commitId
    Thread.sleep(5)
    val c2 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("f" to "2")), "cp2").commitId

    assertTrue("drops the targeted checkpoint", JGitEngine.dropCheckpoint(dir, c1!!))
    val remaining = JGitEngine.listCheckpoints(dir)
    assertEquals(1, remaining.size)
    assertEquals("the other checkpoint survives", c2, remaining[0].commitId)

    // Unknown / invalid commits are no-ops, not errors.
    assertFalse(JGitEngine.dropCheckpoint(dir, "0".repeat(40)))
    assertFalse(JGitEngine.dropCheckpoint(dir, "not-a-sha"))
    assertEquals("a no-op drop changes nothing", 1, JGitEngine.listCheckpoints(dir).size)
  }

  @Test
  fun clearCheckpointsDeletesTheRepoDirEntirely() {
    val dir = tempDir()
    JGitEngine.commitWorkingTree(dir, zipOf(mapOf("secret.txt" to "token")), "cp1")
    assertTrue("repo exists before clear", File(File(dir), ".git").exists())

    assertTrue("clear removes the dir", JGitEngine.clearCheckpoints(dir))
    assertFalse("the repo dir is gone — no recoverable data", File(dir).exists())

    // A fresh capture re-inits cleanly into the cleared lane.
    val r = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a" to "1")), "cp2")
    assertTrue("re-init after clear", r.committed)
    assertEquals(1, JGitEngine.listCheckpoints(dir).size)

    // Clearing a non-existent dir is a no-op false (not an error).
    assertFalse(JGitEngine.clearCheckpoints(File(tempDir(), "absent").absolutePath))
  }

  @Test
  fun archiveOfMissingCommitReturnsNull() {
    val dir = tempDir()
    JGitEngine.commitWorkingTree(dir, zipOf(mapOf("f" to "1")), "cp1")
    assertNull(JGitEngine.archiveCommit(dir, "0".repeat(40)))
    assertNull(JGitEngine.archiveCommit(dir, "not-a-sha"))
  }

  // -- Diff transport (manifest-rsync) ---------------------------------------

  @Test
  fun listManifestReadsNewestCheckpointAndHashesContent() {
    val dir = tempDir()
    assertTrue("no checkpoint yet -> empty manifest", JGitEngine.listManifest(dir).isEmpty())

    JGitEngine.commitWorkingTree(
      dir,
      zipOf(mapOf("a.txt" to "x", "dup.txt" to "x", "b.txt" to "y", "sub/c.txt" to "z")),
      "cp1",
    )
    val m = JGitEngine.listManifest(dir)
    assertEquals(setOf("a.txt", "dup.txt", "b.txt", "sub/c.txt"), m.keys)
    assertTrue("blob ids are 40-hex", m["a.txt"]!!.matches(Regex("[0-9a-f]{40}")))
    assertEquals("identical content -> identical blob hash", m["a.txt"], m["dup.txt"])
    assertNotEquals("different content -> different hash", m["a.txt"], m["b.txt"])

    // The base tracks the NEWEST checkpoint, not HEAD: a later capture rebases it.
    // commitTime is second-resolution, so separate cp2 to make "newest" unambiguous.
    Thread.sleep(1000)
    JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "x")), "cp2")
    assertEquals(setOf("a.txt"), JGitEngine.listManifest(dir).keys)
  }

  @Test
  fun commitDeltaAppliesChangesDeletionsAndKeepsUntouched() {
    val dir = tempDir()
    JGitEngine.commitWorkingTree(
      dir,
      zipOf(mapOf("a.txt" to "one", "sub/b.txt" to "two", "c.txt" to "three")),
      "cp1",
    )
    // Delta: edit a.txt, add d.txt, delete sub/b.txt; c.txt is NOT in the delta.
    val r = JGitEngine.commitDelta(
      dir,
      zipOf(mapOf("a.txt" to "ONE", "d.txt" to "four")),
      listOf("sub/b.txt"),
      mapOf("a.txt" to blobSha("ONE"), "c.txt" to blobSha("three"), "d.txt" to blobSha("four")),
      "cp2",
    )
    assertTrue("delta commits", r.committed)
    assertNotNull(r.commitId)
    assertTrue("returns a tree id to verify", r.treeId!!.matches(Regex("[0-9a-f]{40}")))

    val tree = unzip(JGitEngine.archiveCommit(dir, r.commitId!!)!!)
    assertEquals("ONE", tree["a.txt"]) // changed
    assertEquals("four", tree["d.txt"]) // added
    assertEquals("three", tree["c.txt"]) // untouched survives — there is no clear-first
    assertNull("deleted path is gone", tree["sub/b.txt"])
  }

  @Test
  fun commitDeltaHandlesDirFileTransitions() {
    val dir = tempDir()
    // x is a file; y/inner.txt makes y a directory.
    JGitEngine.commitWorkingTree(dir, zipOf(mapOf("x" to "file", "y/inner.txt" to "indir")), "cp1")

    // file→dir: delete file x, write x/leaf.txt. dir→file: write file y over the dir.
    val r = JGitEngine.commitDelta(
      dir,
      zipOf(mapOf("x/leaf.txt" to "nowdir", "y" to "nowfile")),
      listOf("x"),
      mapOf("x/leaf.txt" to blobSha("nowdir"), "y" to blobSha("nowfile")),
      "cp2",
    )
    assertTrue(r.committed)
    val tree = unzip(JGitEngine.archiveCommit(dir, r.commitId!!)!!)
    assertEquals("nowdir", tree["x/leaf.txt"])
    assertNull("old file x is gone", tree["x"])
    assertEquals("nowfile", tree["y"])
    assertNull("old dir entry y/inner.txt is gone", tree["y/inner.txt"])
  }

  @Test
  fun commitDeltaOnEmptyRepoReturnsFalseSoCallerFallsBack() {
    val r = JGitEngine.commitDelta(tempDir(), zipOf(mapOf("a" to "1")), emptyList(), emptyMap(), "cp")
    assertFalse("no base -> not committed; the caller must full-capture", r.committed)
    assertNull(r.commitId)
  }

  @Test
  fun commitDeltaDedupsIdenticalResultTree() {
    val dir = tempDir()
    val c1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a" to "1")), "cp1")
    // Empty delta + no deletions -> result tree identical to cp1.
    val r = JGitEngine.commitDelta(dir, zipOf(emptyMap()), emptyList(), mapOf("a" to blobSha("1")), "cp2")
    assertFalse("identical result tree -> no new commit", r.committed)
    assertEquals(c1.commitId, r.commitId)
    assertEquals(1, JGitEngine.listCheckpoints(dir).size)
  }

  @Test
  fun checkpointBlobsStayRawDespiteCapturedGitattributes() {
    // The captured tree carries a .gitattributes that WOULD normalize CRLF->LF, plus
    // a CRLF file. .git/info/attributes (`* -text`) must override it so the stored
    // blob is the RAW bytes — matching the sandbox's `git hash-object --no-filters`,
    // without which every delta verify fails (Push's `* text=auto eol=lf`).
    val dir = tempDir()
    val crlf = "line1\r\nline2\r\n"
    JGitEngine.commitWorkingTree(
      dir,
      zipOf(mapOf(".gitattributes" to "* text=auto eol=lf\n", "win.txt" to crlf)),
      "cp1",
    )
    val m = JGitEngine.listManifest(dir)
    assertEquals("blob is RAW CRLF content, not LF-normalized", blobSha(crlf), m["win.txt"])
  }

  @Test
  fun fullCaptureStagesFilesEvenWhenCapturedGitignoreWouldIgnoreThem() {
    val dir = tempDir()
    val ignoredPath = "sandbox/__pycache__/app.cpython-314.pyc"

    val r = JGitEngine.commitWorkingTree(
      dir,
      zipOf(mapOf(".gitignore" to "*.pyc\n", ignoredPath to "bytecode")),
      "cp1",
    )

    assertTrue(r.committed)
    val m = JGitEngine.listManifest(dir)
    assertEquals(blobSha("bytecode"), m[ignoredPath])
    val tree = unzip(JGitEngine.archiveCommit(dir, r.commitId!!)!!)
    assertEquals("bytecode", tree[ignoredPath])
  }

  @Test
  fun commitDeltaStagesFilesEvenWhenCapturedGitignoreWouldIgnoreThem() {
    val dir = tempDir()
    val ignoredPath = "sandbox/__pycache__/app.cpython-314.pyc"
    JGitEngine.commitWorkingTree(dir, zipOf(mapOf(".gitignore" to "*.pyc\n", "a.txt" to "base")), "cp1")

    val r = JGitEngine.commitDelta(
      dir,
      zipOf(mapOf(ignoredPath to "bytecode")),
      emptyList(),
      mapOf(
        ".gitignore" to blobSha("*.pyc\n"),
        "a.txt" to blobSha("base"),
        ignoredPath to blobSha("bytecode"),
      ),
      "cp2",
    )

    assertTrue("delta commits ignored-but-captured files", r.committed)
    assertNotNull(r.commitId)
    val tree = unzip(JGitEngine.archiveCommit(dir, r.commitId!!)!!)
    assertEquals("bytecode", tree[ignoredPath])
    assertEquals(blobSha("bytecode"), JGitEngine.listManifest(dir)[ignoredPath])
  }

  @Test
  fun captureClearsStaleCheckpointIndexLock() {
    val dir = tempDir()
    val first = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "one")), "cp1")
    assertTrue(first.committed)

    val lock = File(File(dir, ".git"), "index.lock")
    lock.writeText("stale")

    val second = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a.txt" to "two")), "cp2")

    assertTrue(second.committed)
    assertFalse("stale index.lock is removed before rebuilding the checkpoint index", lock.exists())
    val tree = unzip(JGitEngine.archiveCommit(dir, second.commitId!!)!!)
    assertEquals("two", tree["a.txt"])
  }

  @Test
  fun commitDeltaRefusesToPublishOnVerifyMismatch() {
    val dir = tempDir()
    val c1 = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("a" to "1")), "cp1")
    // Apply a real change but hand a WRONG expected manifest: verify must fail and
    // NO ref may be published — an unverified checkpoint can never land.
    val r =
      JGitEngine.commitDelta(dir, zipOf(mapOf("a" to "2")), emptyList(), mapOf("a" to blobSha("999")), "cp2")
    assertFalse("verify mismatch -> not committed", r.committed)
    assertNull("verify mismatch -> no ref published", r.commitId)
    val list = JGitEngine.listCheckpoints(dir)
    assertEquals("only the original checkpoint exists", 1, list.size)
    assertEquals(c1.commitId, list[0].commitId)
  }

  @Test
  fun commitDeltaRestoresCleanBaseAfterFailedDeltaResidue() {
    val dir = tempDir()
    val base = JGitEngine.commitWorkingTree(dir, zipOf(mapOf("keep.txt" to "base")), "cp1")

    val failed = JGitEngine.commitDelta(
      dir,
      zipOf(mapOf("stale.txt" to "stale")),
      emptyList(),
      mapOf("keep.txt" to blobSha("base")),
      "bad",
    )
    assertFalse("bad expected manifest fails verify", failed.committed)
    assertNull("failed verify does not publish a checkpoint", failed.commitId)
    assertNotNull(failed.detail)

    val recovered = JGitEngine.commitDelta(
      dir,
      zipOf(emptyMap()),
      emptyList(),
      mapOf("keep.txt" to blobSha("base")),
      "cp2",
    )

    assertFalse("clean base with empty delta dedups to existing checkpoint", recovered.committed)
    assertEquals(base.commitId, recovered.commitId)
    assertNull("no phantom onlyActual residue after restoring the base", recovered.detail)
    val tree = unzip(JGitEngine.archiveCommit(dir, recovered.commitId!!)!!)
    assertEquals("base", tree["keep.txt"])
    assertNull(tree["stale.txt"])
  }
}
