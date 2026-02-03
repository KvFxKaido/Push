package com.diff.wrapper

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONObject
import java.io.File

/**
 * JavaScript bridge that exposes Android-specific features to the PWA.
 * 
 * Usage from JavaScript:
 * if (window.DiffAndroid) {
 *   window.DiffAndroid.shareText("Check out this code!");
 * }
 */
class DiffBridge(private val context: Context) {
    
    /**
     * Share text using Android's native share sheet.
     * 
     * @param text The text to share
     */
    @JavascriptInterface
    fun shareText(text: String) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        
        val chooser = Intent.createChooser(intent, "Share via")
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    }
    
    /**
     * Share a file using Android's native share sheet.
     * 
     * @param path Path to the file to share
     * @param mimeType MIME type of the file (e.g., "text/plain", "image/png")
     */
    @JavascriptInterface
    fun shareFile(path: String, mimeType: String) {
        // TODO: Implement file sharing with FileProvider
        showToast("File sharing not yet implemented")
    }
    
    /**
     * Read a file from Android's filesystem.
     * Returns the file content as a string.
     * 
     * @param path Path to the file to read
     * @return File content as string, or error message
     */
    @JavascriptInterface
    fun readFile(path: String): String {
        return try {
            val file = File(path)
            if (file.exists() && file.canRead()) {
                file.readText()
            } else {
                """{"error": "File not found or not readable: $path"}"""
            }
        } catch (e: Exception) {
            """{"error": "${e.message}"}"""
        }
    }
    
    /**
     * Write content to a file on Android's filesystem.
     * 
     * @param path Path where the file should be written
     * @param content Content to write
     * @return Success/error message as JSON
     */
    @JavascriptInterface
    fun writeFile(path: String, content: String): String {
        return try {
            val file = File(path)
            file.parentFile?.mkdirs()
            file.writeText(content)
            """{"success": true, "path": "$path"}"""
        } catch (e: Exception) {
            """{"error": "${e.message}"}"""
        }
    }
    
    /**
     * Show a native Android toast message.
     * 
     * @param message The message to display
     */
    @JavascriptInterface
    fun showToast(message: String) {
        android.os.Handler(context.mainLooper).post {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }
    
    /**
     * Get device information as JSON.
     * Useful for the PWA to detect it's running in the native wrapper.
     * 
     * @return JSON string with device info
     */
    @JavascriptInterface
    fun getDeviceInfo(): String {
        val info = JSONObject().apply {
            put("isNativeWrapper", true)
            put("platform", "android")
            put("version", android.os.Build.VERSION.SDK_INT)
            put("model", android.os.Build.MODEL)
            put("manufacturer", android.os.Build.MANUFACTURER)
        }
        return info.toString()
    }
    
    /**
     * Open a URL in the system browser (outside the WebView).
     * 
     * @param url The URL to open
     */
    @JavascriptInterface
    fun openExternalBrowser(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
