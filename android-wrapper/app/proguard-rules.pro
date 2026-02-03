# Diff Android Wrapper ProGuard Rules

# Keep JavaScript interface
-keep class com.diff.wrapper.DiffBridge { *; }
-keepclassmembers class com.diff.wrapper.DiffBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep WebView JavaScript interfaces
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep JSON serialization
-keepattributes Signature
-keepattributes *Annotation*
-keep class org.json.** { *; }
