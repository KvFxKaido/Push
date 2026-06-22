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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
