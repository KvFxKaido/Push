package com.push.app;

import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestHighestRefreshRate();
    }

    @Override
    public void onResume() {
        super.onResume();
        // The preferred-mode hint can be dropped across multi-window, display, or
        // power-saver transitions; re-asserting it is cheap and idempotent.
        requestHighestRefreshRate();
    }

    /**
     * Opt the window into the display's highest refresh rate (e.g. 120Hz).
     *
     * Several OEMs (notably Samsung) pin WebView-backed windows to 60Hz unless
     * the app explicitly prefers a higher display mode, so the Capacitor shell
     * would otherwise never see the panel's full rate even on 120Hz hardware.
     * Only modes matching the active resolution are considered — requesting a
     * mode that also changes resolution would trigger a jarring mode switch.
     */
    @SuppressWarnings("deprecation") // getDefaultDisplay: pre-R fallback only
    private void requestHighestRefreshRate() {
        Display display = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? getDisplay()
            : getWindowManager().getDefaultDisplay();
        if (display == null) {
            return;
        }
        Display.Mode activeMode = display.getMode();
        Display.Mode bestMode = activeMode;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() == activeMode.getPhysicalWidth()
                && mode.getPhysicalHeight() == activeMode.getPhysicalHeight()
                && mode.getRefreshRate() > bestMode.getRefreshRate()) {
                bestMode = mode;
            }
        }
        if (bestMode.getModeId() == activeMode.getModeId()) {
            // Already at the highest mode for this resolution (adaptive panel
            // running flat out, or a 60Hz-only display). Don't cast a redundant
            // mode vote — pinning the current mode would keep the OS from
            // adaptively lowering refresh while content is static. A vote set
            // by an earlier pass (when an upgrade was needed) stays in place so
            // OEM WebView heuristics can't re-pin the window to 60Hz.
            return;
        }
        WindowManager.LayoutParams params = getWindow().getAttributes();
        if (params.preferredDisplayModeId == bestMode.getModeId()) {
            return;
        }
        params.preferredDisplayModeId = bestMode.getModeId();
        getWindow().setAttributes(params);
    }
}
