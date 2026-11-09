package local.almaandroid.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.net.URL;

/**
 * Entry point for in-app updates.
 *
 * This class owns the policy — only this repository's GitHub Release assets are
 * accepted — and nothing else. The transfer itself belongs to
 * {@link UpdateDownloadService}, so leaving the activity or freezing the
 * WebView cannot cancel a download that the user already started.
 */
@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private static final String RELEASE_HOST = "github.com";
    private static final String ASSET_HOST = "release-assets.githubusercontent.com";
    private static final String RELEASE_PREFIX = "/xiaotiyanlove-star/alma-android/releases/download/";

    /** The state the page polls while the service is working. */
    public static final class State {
        public static volatile String phase = "idle";
        public static volatile String reason = "";
        public static volatile int progress = 0;

        static void set(String next, String why, int percent) {
            phase = next;
            reason = why;
            progress = percent;
        }
    }

    /** MainActivity supplies the system installer for a verified APK. */
    public interface Installer {
        void installUpdate(File apk);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(new JSObject()
                .put("phase", State.phase)
                .put("reason", State.reason)
                .put("progress", State.progress));
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String checksumUrl = call.getString("checksumUrl");
        String version = call.getString("version");
        if (url == null || checksumUrl == null || version == null || !isReleaseUrl(url) || !isReleaseUrl(checksumUrl)) {
            call.reject("Invalid update address");
            return;
        }
        if (!version.matches("[0-9A-Za-z.+-]{1,40}")) {
            call.reject("Invalid update version");
            return;
        }
        if (!(getActivity() instanceof Installer)) {
            call.reject("Installer unavailable");
            return;
        }
        if (UpdateDownloadService.isRunning()) {
            call.resolve(new JSObject().put("started", true));
            return;
        }
        State.set("downloading", "", 0);
        UpdateDownloadService.startFrom(getContext(), url, checksumUrl, version);
        call.resolve(new JSObject().put("started", true));
    }

    private static boolean isReleaseUrl(String value) {
        try {
            URL url = new URL(value);
            if (!"https".equals(url.getProtocol())) return false;
            if (RELEASE_HOST.equals(url.getHost())) return url.getPath().startsWith(RELEASE_PREFIX);
            return ASSET_HOST.equals(url.getHost());
        } catch (Exception error) {
            return false;
        }
    }
}
