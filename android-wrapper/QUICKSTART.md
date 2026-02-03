# Quick Start Guide

Get Push running as a native Android app in 5 minutes.

## Prerequisites

1. **Android Studio** - https://developer.android.com/studio
2. **Java 17+** - Bundled with Android Studio
3. **Your Push PWA** - Built and deployed

## Step 1: Open Project

```bash
cd C:\dev\Push\android-wrapper
```

Open Android Studio → Open → Select `android-wrapper` folder

Wait for Gradle sync (~2-3 minutes first time)

## Step 2: Configure URL

Edit `app/src/main/java/com/push/wrapper/MainActivity.kt` line 93:

```kotlin
// Change this to your Push URL
loadUrl("https://your-push-url.com")
```

For local testing:
```kotlin
loadUrl("http://10.0.2.2:5173")  // Vite dev server from emulator
```

## Step 3: Run

### Option A: Emulator (easiest)
1. Click phone icon → "Device Manager"
2. Create device (Pixel 6, API 34)
3. Click green "Run" button (Shift+F10)

### Option B: Physical Device
1. Enable Developer Options:
   - Settings → About → Tap "Build Number" 7 times
2. Enable USB Debugging:
   - Settings → Developer Options → USB Debugging
3. Connect via USB
4. Click "Run" → Select device

## Step 4: Test

App loads your PWA. Test Android bridge from Chrome DevTools:

Chrome → `chrome://inspect` → Find device → "Inspect"

```javascript
window.PushAndroid.getDeviceInfo()
window.PushAndroid.showToast("Hello!")
```

## Add to Your PWA

Copy TypeScript helper:
```bash
cp android-wrapper/android-bridge.ts app/src/lib/
```

Use in React:
```typescript
import { isAndroidWrapper, shareText } from '@/lib/android-bridge';

function MyComponent() {
  return (
    <button onClick={() => shareText('Check this out!')}>
      Share {isAndroidWrapper() ? '(Native)' : '(Web)'}
    </button>
  );
}
```

## Troubleshooting

**Blank screen**: Check URL, INTERNET permission
**Bridge not working**: Check ProGuard rules
**Slow build**: First build downloads ~500MB

## Next Steps

1. Bundle PWA for offline mode
2. Add app icons (https://icon.kitchen)
3. Test native features (share, files)
4. Build release: `./gradlew assembleRelease`

See README.md for full docs.
