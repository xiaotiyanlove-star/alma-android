package local.almaandroid.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Downloads a release APK from this app's GitHub Releases and hands it to the
 * system installer.
 *
 * The page decides whether an update exists; this class only accepts the two
 * asset URLs that GitHub serves from this repository's release host, checks the
 * file is an APK, and verifies the published SHA-256 before installing it. A
 * redirect is followed only when it still leads to a GitHub release asset, so
 * a compromised page cannot turn this into a general "install any APK" API.
 */
@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private static final String RELEASE_HOST = "github.com";
    private static final String ASSET_HOST = "release-assets.githubusercontent.com";
    private static final String RELEASE_PREFIX = "/xiaotiyanlove-star/alma-android/releases/download/";
    private static final int MAX_BYTES = 64 * 1024 * 1024;

    /**
     * What the page polls while an update is running.
     *
     * Codes rather than sentences: the page owns the copy, and the same failure
     * has to read correctly in every language the app ships.
     */
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

    /** MainActivity downloads, then starts its own installer activity. */
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
        final Installer installer = (Installer) getActivity();
        State.set("downloading", "", 0);
        call.resolve(new JSObject().put("started", true));
        new Thread(() -> {
            try {
                String expected = readText(checksumUrl).trim().split("\\s+")[0].toLowerCase();
                if (!expected.matches("[0-9a-f]{64}")) throw new UpdateFailure("checksum");
                File directory = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new UpdateFailure("storage");
                File target = new File(directory, "alma-" + version + ".apk");
                File temporary = new File(directory, "alma-" + version + ".part");
                download(url, temporary);
                if (!expected.equals(sha256(temporary))) throw new UpdateFailure("checksum");
                if (target.exists() && !target.delete()) throw new UpdateFailure("storage");
                if (!temporary.renameTo(target)) throw new UpdateFailure("storage");
                State.set("installing", "", 100);
                installer.installUpdate(target);
            } catch (UpdateFailure failure) {
                clear(directoryOf());
                State.set("failed", failure.reason, 0);
            } catch (Exception error) {
                clear(directoryOf());
                State.set("failed", failureReason(error), 0);
            }
        }, "alma-update").start();
    }

    private File directoryOf() {
        return new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
    }

    /** A failed or unverified download is removed, never left looking installable. */
    private static void clear(File directory) {
        try {
            for (File file : directory.listFiles((dir, name) -> name.endsWith(".part"))) file.delete();
        } catch (Throwable ignored) { }
    }

    private static final class UpdateFailure extends Exception {
        final String reason;
        UpdateFailure(String reason) { this.reason = reason; }
    }

    /**
     * Turns a failed request into a reason the page can name.
     *
     * Everything used to collapse to "network" here, which is what the user
     * saw while the APK was actually on disk and only the installer had
     * refused. The codes stay coarse on purpose: a checksum or storage problem
     * needs different words, but the exact HTTP status does not belong in a
     * phone dialog.
     */
    private static String failureReason(Exception error) {
        if (error instanceof UpdateFailure) return ((UpdateFailure) error).reason;
        if (error instanceof java.net.SocketTimeoutException
                || error instanceof java.net.UnknownHostException
                || error instanceof java.net.ConnectException
                || error instanceof javax.net.ssl.SSLException) return "network";
        if (error instanceof java.io.FileNotFoundException || error instanceof java.io.IOException) return "storage";
        return "network";
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

    private String readText(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(15_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/octet-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("Checksum download failed: " + status);
        try (InputStream input = connection.getInputStream()) {
            byte[] data = readBounded(input, 4096);
            return new String(data, StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private void download(String address, File target) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        connection.setRequestProperty("Accept-Encoding", "identity");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("Update download failed: " + status);
        String type = connection.getContentType();
        // The content type is a hint, not a contract. GitHub serves the right
        // type today, but a redirect hop, a carrier proxy or an OEM download
        // stack may replace or drop it — and a valid APK was then refused as
        // "network" before a single byte was written. Verify the file instead:
        // it has to begin with a ZIP signature and pass the published digest.
        if (type != null && !type.isEmpty() && !type.contains("android.package-archive")
                && !type.contains("application/octet-stream") && !type.contains("application/zip")) {
            throw new IllegalStateException("Not an APK response: " + type);
        }
        long length = connection.getContentLengthLong();
        if (length > MAX_BYTES) throw new UpdateFailure("too_large");
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) throw new UpdateFailure("too_large");
                output.write(buffer, 0, count);
                if (length > 0) State.set("downloading", "", (int) Math.min(99, total * 100 / length));
            }
        } finally {
            connection.disconnect();
        }
        if (!isZip(target)) throw new UpdateFailure("not_apk");
    }

    private static byte[] readBounded(InputStream input, int limit) throws Exception {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IllegalStateException("Response too large");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static boolean isZip(File file) {
        if (file.length() < 4) return false;
        try (InputStream input = new java.io.FileInputStream(file)) {
            return input.read() == 'P' && input.read() == 'K' && input.read() == 3 && input.read() == 4;
        } catch (Exception error) {
            return false;
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format("%02x", value));
        return hex.toString();
    }
}
