package com.push.nativegit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
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
import org.eclipse.jgit.lib.Constants
import org.eclipse.jgit.lib.ObjectInserter

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
    Thread.sleep(1000) // commitTime is second-resolution; separate the ordering
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
}
