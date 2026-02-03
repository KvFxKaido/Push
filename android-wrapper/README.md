# Push Android Wrapper

Native Android wrapper for the Push PWA. Get a real Android app with native features while keeping your existing PWA codebase.

## Quick Start

### 1. Install Android Studio
Download from https://developer.android.com/studio

### 2. Open Project
Open Android Studio → Open → Select `android-wrapper` folder
Wait for Gradle sync (~2-3 minutes first time)

### 3. Configure PWA URL
Edit `app/src/main/java/com/push/wrapper/MainActivity.kt` line 93:
```kotlin
loadUrl("https://your-push-url.com")  // Change this!
```

### 4. Run
Click green "Run" button in Android Studio (or Shift+F10)

See `QUICKSTART.md` for detailed setup.

## What This Does

- Wraps your Push PWA in native WebView
- Adds Android features via JavaScript bridge
- Proper back button + edge-to-edge display
- Offline-first support (bundle PWA assets)
- Native share sheet integration
- File system access

## JavaScript Bridge

Your PWA can detect the native wrapper and use Android features:

```javascript
if (window.PushAndroid) {
  // Get device info
  const info = JSON.parse(window.PushAndroid.getDeviceInfo());

  // Share text
  window.PushAndroid.shareText('Check this out!');

  // Show toast
  window.PushAndroid.showToast('Hello Android!');

  // File access
  const content = window.PushAndroid.readFile('/path/to/file');
  window.PushAndroid.writeFile('/path/to/file', 'content');
}
```

Copy `android-bridge.ts` to your PWA for type-safe access:
```bash
cp android-bridge.ts ../app/src/lib/
```

## Testing Strategy

**Fast loop (95% of dev):**
- Keep using Vite dev server
- Test in Chrome mobile emulator
- Browser DevTools

**Slow loop (5% of dev):**
- Run Android app
- Test native features only (share, files, etc.)

## Files

```
android-wrapper/
├── app/
│   ├── src/main/
│   │   ├── java/com/push/wrapper/
│   │   │   ├── MainActivity.kt       # WebView + navigation
│   │   │   └── PushBridge.kt        # JS bridge
│   │   ├── res/values/
│   │   │   ├── strings.xml
│   │   │   └── themes.xml
│   │   └── AndroidManifest.xml
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── android-bridge.ts                # Copy to your PWA
├── QUICKSTART.md
└── README.md
```

## Bundle PWA for Offline

1. Build PWA: `cd ../app && npm run build`
2. Copy to assets: `cp -r dist/* android-wrapper/app/src/main/assets/`
3. Change MainActivity.kt: `loadUrl("file:///android_asset/index.html")`

## Troubleshooting

**Blank screen?**
- Check URL in MainActivity.kt
- Verify INTERNET permission
- Enable WebView debugging and inspect in Chrome

**JavaScript bridge not working?**
- Check `@JavascriptInterface` annotations
- Verify ProGuard rules for release builds

## Why This Approach?

**Pros:**
- Keep existing PWA codebase
- Fast development (Vite hot reload)
- Progressive enhancement
- Smaller APK than native rewrite

**Cons:**
- WebView performance vs pure native
- Limited Android API access
- JavaScript bridge complexity

For Push, this is the right tradeoff: native app without rebuilding everything.

## Next Steps

- Add app icons (use https://icon.kitchen)
- Test on real device
- Bundle PWA for offline mode
- Build release APK: `./gradlew assembleRelease`
