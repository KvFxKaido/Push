package com.diff.wrapper

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)
        
        setContent {
            DiffWebView(
                onWebViewCreated = { webView = it }
            )
        }
        
        // Handle back button navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DiffWebView(
    onWebViewCreated: (WebView) -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                // Enable JavaScript and modern web features
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    cacheMode = WebSettings.LOAD_DEFAULT
                    
                    // Enable service workers and PWA features
                    setAppCacheEnabled(true)
                    setAppCachePath(ctx.cacheDir.absolutePath)
                    
                    // Allow file access for bundled assets
                    allowFileAccess = true
                    allowContentAccess = true
                    
                    // Modern web standards
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                    mediaPlaybackRequiresUserGesture = false
                    
                    // Performance
                    setRenderPriority(WebSettings.RenderPriority.HIGH)
                    cacheMode = WebSettings.LOAD_DEFAULT
                }
                
                // Custom WebViewClient for navigation control
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        url: String
                    ): Boolean {
                        // Let WebView handle all navigation
                        return false
                    }
                }
                
                // Add JavaScript bridge for Android-specific features
                addJavascriptInterface(
                    DiffBridge(context),
                    "DiffAndroid"
                )
                
                // Load the PWA
                // Option 1: Load from URL (requires internet)
                loadUrl("https://diff.example.com")
                
                // Option 2: Load bundled assets (offline-first)
                // loadUrl("file:///android_asset/index.html")
                
                onWebViewCreated(this)
            }
        }
    )
}
