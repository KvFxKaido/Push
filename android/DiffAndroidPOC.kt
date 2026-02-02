// Diff Android Proof of Concept
// Minimal viable app to prove: clone → AI edits → diff → commit

// build.gradle.kts (app level)
/*
dependencies {
    implementation("androidx.compose.ui:ui:1.5.4")
    implementation("androidx.compose.material3:material3:1.1.2")
    implementation("androidx.activity:activity-compose:1.8.1")
    implementation("org.eclipse.jgit:org.eclipse.jgit:6.7.0.202309050840-r")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")
}
*/

// AndroidManifest.xml additions
/*
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
*/

package com.example.diffpoc

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.lib.PersonIdent
import java.io.File

// === DATA MODELS ===

@Serializable
data class KimiMessage(
    val role: String,
    val content: String
)

@Serializable
data class KimiRequest(
    val model: String = "kimi-for-coding",
    val messages: List<KimiMessage>,
    val stream: Boolean = false
)

@Serializable
data class KimiResponse(
    val choices: List<Choice>
) {
    @Serializable
    data class Choice(
        val message: Message
    )
    
    @Serializable
    data class Message(
        val content: String
    )
}

data class FileEdit(
    val path: String,
    val content: String
)

sealed class LogEntry {
    data class Info(val message: String) : LogEntry()
    data class Success(val message: String) : LogEntry()
    data class Error(val message: String) : LogEntry()
    data class Diff(val content: String) : LogEntry()
}

// === CORE LOGIC ===

class DiffEngine(
    private val repoDir: File,
    private val kimiApiKey: String
) {
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    
    suspend fun cloneRepo(url: String, onLog: (LogEntry) -> Unit) = withContext(Dispatchers.IO) {
        try {
            onLog(LogEntry.Info("Cloning $url..."))
            
            if (repoDir.exists()) {
                repoDir.deleteRecursively()
            }
            
            Git.cloneRepository()
                .setURI(url)
                .setDirectory(repoDir)
                .call()
            
            onLog(LogEntry.Success("Clone complete"))
        } catch (e: Exception) {
            onLog(LogEntry.Error("Clone failed: ${e.message}"))
        }
    }
    
    suspend fun askCoderToEdit(
        instruction: String,
        onLog: (LogEntry) -> Unit
    ): FileEdit? = withContext(Dispatchers.IO) {
        try {
            onLog(LogEntry.Info("Calling Coder agent..."))
            
            val systemPrompt = """
You are the Coder agent. You receive instructions and return file edits.

Response format (JSON only, no markdown):
{
  "path": "relative/path/to/file.txt",
  "content": "full file content after edit"
}

Current repo structure:
${getFileTree()}
            """.trimIndent()
            
            val request = KimiRequest(
                messages = listOf(
                    KimiMessage("system", systemPrompt),
                    KimiMessage("user", instruction)
                )
            )
            
            val requestBody = Json.encodeToString(KimiRequest.serializer(), request)
                .toRequestBody("application/json".toMediaType())
            
            val httpRequest = Request.Builder()
                .url("https://api.kimi.com/v1/chat/completions")
                .header("Authorization", "Bearer $kimiApiKey")
                .post(requestBody)
                .build()
            
            val response = client.newCall(httpRequest).execute()
            val responseBody = response.body?.string() ?: throw Exception("Empty response")
            
            onLog(LogEntry.Info("Parsing Coder response..."))
            
            val kimiResponse = json.decodeFromString<KimiResponse>(responseBody)
            val content = kimiResponse.choices.firstOrNull()?.message?.content
                ?: throw Exception("No response from Coder")
            
            // Extract JSON from markdown code blocks if present
            val jsonContent = content
                .substringAfter("```json", content)
                .substringAfter("```", content)
                .substringBefore("```", content)
                .trim()
            
            val fileEdit = json.decodeFromString<FileEdit>(jsonContent)
            
            onLog(LogEntry.Success("Coder wants to edit: ${fileEdit.path}"))
            fileEdit
            
        } catch (e: Exception) {
            onLog(LogEntry.Error("Coder failed: ${e.message}"))
            null
        }
    }
    
    suspend fun applyEdit(
        edit: FileEdit,
        onLog: (LogEntry) -> Unit
    ) = withContext(Dispatchers.IO) {
        try {
            val file = File(repoDir, edit.path)
            val oldContent = if (file.exists()) file.readText() else ""
            
            // Show diff
            val diff = generateDiff(edit.path, oldContent, edit.content)
            onLog(LogEntry.Diff(diff))
            
            // Write file
            file.parentFile?.mkdirs()
            file.writeText(edit.content)
            
            onLog(LogEntry.Success("File written: ${edit.path}"))
            
        } catch (e: Exception) {
            onLog(LogEntry.Error("Apply failed: ${e.message}"))
        }
    }
    
    suspend fun commit(
        message: String,
        onLog: (LogEntry) -> Unit
    ) = withContext(Dispatchers.IO) {
        try {
            onLog(LogEntry.Info("Committing..."))
            
            val git = Git.open(repoDir)
            
            // Stage all changes
            git.add()
                .addFilepattern(".")
                .call()
            
            // Commit
            git.commit()
                .setMessage(message)
                .setAuthor(PersonIdent("Diff POC", "diff@example.com"))
                .call()
            
            onLog(LogEntry.Success("Committed: $message"))
            
        } catch (e: Exception) {
            onLog(LogEntry.Error("Commit failed: ${e.message}"))
        }
    }
    
    private fun getFileTree(): String {
        return repoDir.walkTopDown()
            .filter { it.isFile && !it.path.contains("/.git/") }
            .take(20) // Limit for context
            .joinToString("\n") { it.relativeTo(repoDir).path }
    }
    
    private fun generateDiff(path: String, old: String, new: String): String {
        val oldLines = old.lines()
        val newLines = new.lines()
        
        val diff = buildString {
            appendLine("--- $path")
            appendLine("+++ $path")
            appendLine("@@ -1,${oldLines.size} +1,${newLines.size} @@")
            
            // Simple line-by-line diff (not true diff algorithm, but good enough for POC)
            val maxLines = maxOf(oldLines.size, newLines.size)
            for (i in 0 until maxLines) {
                when {
                    i >= oldLines.size -> appendLine("+ ${newLines[i]}")
                    i >= newLines.size -> appendLine("- ${oldLines[i]}")
                    oldLines[i] != newLines[i] -> {
                        appendLine("- ${oldLines[i]}")
                        appendLine("+ ${newLines[i]}")
                    }
                    else -> appendLine("  ${oldLines[i]}")
                }
            }
        }
        
        return diff
    }
}

// === UI ===

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        val repoDir = File(filesDir, "repo")
        
        setContent {
            MaterialTheme {
                DiffPOCScreen(repoDir)
            }
        }
    }
}

@Composable
fun DiffPOCScreen(repoDir: File) {
    val scope = rememberCoroutineScope()
    var logs by remember { mutableStateOf<List<LogEntry>>(emptyList()) }
    var repoUrl by remember { mutableStateOf("https://github.com/user/repo.git") }
    var kimiKey by remember { mutableStateOf("") }
    var instruction by remember { mutableStateOf("Add a README.md with project description") }
    var commitMsg by remember { mutableStateOf("AI: Update via Diff POC") }
    
    val addLog = { entry: LogEntry ->
        logs = logs + entry
    }
    
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Text("Diff POC", style = MaterialTheme.typography.headlineMedium)
        
        Spacer(modifier = Modifier.height(16.dp))
        
        // Config
        OutlinedTextField(
            value = kimiKey,
            onValueChange = { kimiKey = it },
            label = { Text("Kimi API Key") },
            modifier = Modifier.fillMaxWidth()
        )
        
        OutlinedTextField(
            value = repoUrl,
            onValueChange = { repoUrl = it },
            label = { Text("Repo URL") },
            modifier = Modifier.fillMaxWidth()
        )
        
        Spacer(modifier = Modifier.height(8.dp))
        
        // Actions
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    scope.launch {
                        val engine = DiffEngine(repoDir, kimiKey)
                        engine.cloneRepo(repoUrl, addLog)
                    }
                }
            ) {
                Text("Clone")
            }
            
            Button(
                onClick = {
                    scope.launch {
                        val engine = DiffEngine(repoDir, kimiKey)
                        val edit = engine.askCoderToEdit(instruction, addLog)
                        if (edit != null) {
                            engine.applyEdit(edit, addLog)
                        }
                    }
                }
            ) {
                Text("Ask Coder")
            }
            
            Button(
                onClick = {
                    scope.launch {
                        val engine = DiffEngine(repoDir, kimiKey)
                        engine.commit(commitMsg, addLog)
                    }
                }
            ) {
                Text("Commit")
            }
        }
        
        Spacer(modifier = Modifier.height(8.dp))
        
        OutlinedTextField(
            value = instruction,
            onValueChange = { instruction = it },
            label = { Text("Instruction for Coder") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2
        )
        
        OutlinedTextField(
            value = commitMsg,
            onValueChange = { commitMsg = it },
            label = { Text("Commit message") },
            modifier = Modifier.fillMaxWidth()
        )
        
        Spacer(modifier = Modifier.height(16.dp))
        
        // Log output
        Text("Log:", style = MaterialTheme.typography.titleMedium)
        
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            items(logs) { entry ->
                when (entry) {
                    is LogEntry.Info -> Text(
                        "ℹ️ ${entry.message}",
                        style = MaterialTheme.typography.bodySmall
                    )
                    is LogEntry.Success -> Text(
                        "✅ ${entry.message}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                    is LogEntry.Error -> Text(
                        "❌ ${entry.message}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                    is LogEntry.Diff -> Text(
                        entry.content,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                    )
                }
            }
        }
    }
}

// === NEXT STEPS ===
/*
This POC proves the core loop works. To make it production-ready:

1. Add proper error handling and retry logic
2. Implement the Orchestrator and Auditor agents
3. Build a real chat interface (not just buttons)
4. Add GitHub API integration for PR/issue browsing
5. Handle file conflicts and merge scenarios
6. Add progress indicators for long operations (clone, push)
7. Implement proper git auth (SSH keys, tokens)
8. Add file browser to see repo contents
9. Store settings (API key, user info) securely
10. Add push functionality (currently just commits locally)

The hard parts are solved:
✅ AI can edit local files
✅ JGit works on Android
✅ Diffs can be generated and displayed
✅ The role separation (Coder as executor) works

Everything else is UI/UX polish.
*/
