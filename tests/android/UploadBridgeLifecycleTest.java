package com.zulors.app;

import android.app.Activity;
import android.webkit.WebView;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class UploadBridgeLifecycleTest {
    private UploadCoordinator coordinator;
    private ZulorsUploadBridge bridge;
    private WebView webView;

    @Before public void setup() {
        ReflectionHelpers.setStaticField(UploadCoordinator.class, "instance", null);
        RuntimeEnvironment.getApplication().deleteDatabase("media-publications.db");
    }

    @After public void close() throws Exception {
        if (bridge != null) bridge.destroy();
        if (webView != null) webView.destroy();
        coordinator = UploadCoordinator.get(RuntimeEnvironment.getApplication());
        coordinator.commands.shutdown();
        coordinator.sync.shutdown();
        coordinator.commands.awaitTermination(5, TimeUnit.SECONDS);
        coordinator.sync.awaitTermination(5, TimeUnit.SECONDS);
        coordinator.store.close();
        ReflectionHelpers.setStaticField(UploadCoordinator.class, "instance", null);
    }

    @Test public void bridgeCreatedAfterActivityResumeInheritsForegroundState() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        webView = new WebView(activity);
        bridge = new ZulorsUploadBridge(activity, webView);
        coordinator = UploadCoordinator.get(activity);

        MainActivity.synchronizeUploadBridgeVisibility(bridge, true);
        assertTrue(coordinator.visible);

        MainActivity.synchronizeUploadBridgeVisibility(bridge, false);
        assertFalse(coordinator.visible);
    }
}
