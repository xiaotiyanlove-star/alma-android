package local.almaandroid.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Downloads one release APK, survives the activity leaving the foreground, and
 * hands the verified file back to the installer.
 *
 * This is deliberately a service rather than a thread owned by the plugin: a
 * cancelled Activity or a frozen WebView must not cancel the bytes, and the
 * OS must not reclaim the process while a system download is in progress. The
 * service runs only for the lifetime of one transfer and then removes its own
 * notification.
 *
 * The plugin still decides whether a URL is one of this repository's release
 * assets. This class receives only those accepted URLs, so the two security
 * boundaries stay separate.
 */
public class UpdateDownloadService extends Service {
    static final String CHANNEL_ID = "alma-update-download";
    static final int NOTIFICATION_ID = 7201;
    /**
     * The terminal notifications (ready / failed) get their own id.
     *
     * They are posted as the service is stopping, and `stopForeground(REMOVE)`
     * clears whatever the foreground notification id holds. Sharing the id made
     * the "downloaded, tap to install" notification appear and vanish in the
     * same moment, which is why a finished background download looked like it
     * had done nothing.
     */
    static final int RESULT_NOTIFICATION_ID = 7202;

    static final String ACTION_START = "local.almaandroid.app.UPDATE_START";
    static final String ACTION_PROGRESS = "local.almaandroid.app.UPDATE_PROGRESS";
    static final String ACTION_DONE = "local.almaandroid.app.UPDATE_DONE";
    static final String ACTION_FAILED = "local.almaandroid.app.UPDATE_FAILED";
    static final String EXTRA_URL = "url";
    static final String EXTRA_CHECKSUM_URL = "checksumUrl";
    static final String EXTRA_VERSION = "version";

    private static final int MAX_BYTES = 64 * 1024 * 1024;
    /** Set while a transfer is alive, so a repeated tap cannot start a second. */
    private static volatile boolean running = false;

    static boolean isRunning() { return running; }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_START.equals(intent.getAction())) return START_NOT_STICKY;
        final String url = intent.getStringExtra(EXTRA_URL);
        final String checksumUrl = intent.getStringExtra(EXTRA_CHECKSUM_URL);
        final String version = intent.getStringExtra(EXTRA_VERSION);
        if (url == null || checksumUrl == null || version == null) {
            DownloaderPlugin.State.set("failed", "network", 0);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;
        running = true;
        startInForeground(0);
        DownloaderPlugin.State.set("downloading", "", 0);
        new Thread(() -> transfer(url, checksumUrl, version, startId), "alma-update-service").start();
        return START_NOT_STICKY;
    }

    /**
     * Starts the foreground phase.
     *
     * Android 14 requires the service type at the same call that posts the
     * notification; using the old overload and adding the type later throws.
     */
    private void startInForeground(int progress) {
        Notification notification = buildNotification(progress);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void transfer(String url, String checksumUrl, String version, int startId) {
        File directory = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
        File temporary = new File(directory, "alma-" + version + ".part");
        File target = new File(directory, "alma-" + version + ".apk");
        try {
            if (!directory.isDirectory() && !directory.mkdirs()) throw new UpdateFailure("storage");
            String expected = readText(checksumUrl).trim().split("\\s+")[0].toLowerCase();
            if (!expected.matches("[0-9a-f]{64}")) throw new UpdateFailure("checksum");
            download(url, temporary, expected);
            if (target.exists() && !target.delete()) throw new UpdateFailure("storage");
            if (!temporary.renameTo(target)) throw new UpdateFailure("storage");
            DownloaderPlugin.State.set("installing", "", 100);
            notifyProgress(100);
            // The installer activity is started by MainActivity when it is
            // present. A service cannot own a window; it reports the verified
            // path and the page (or the next resume) opens the installer.
            sendDownloaded(target);
        } catch (UpdateFailure failure) {
            cleanup(temporary);
            DownloaderPlugin.State.set("failed", failure.reason, 0);
            notifyFailure(failure.reason);
        } catch (Exception error) {
            cleanup(temporary);
            String reason = failureReason(error);
            DownloaderPlugin.State.set("failed", reason, 0);
            notifyFailure(reason);
        } finally {
            running = false;
            stopForegroundCompat();
            stopSelf(startId);
        }
    }

    /**
     * Hands the verified file to whatever can still act on it.
     *
     * An activity in the foreground installs immediately. A backgrounded app may
     * not start the system installer — Android rejects the launch — so the path
     * is parked for the next resume and the notification becomes the way in.
     */
    private void sendDownloaded(File target) {
        Intent done = new Intent(ACTION_DONE).setPackage(getPackageName());
        done.putExtra("apkPath", target.getAbsolutePath());
        sendBroadcast(done);
        // This call also decides background versus resumed; it parks the file
        // and posts the ready notification when no foreground can install it.
        MainActivity.installUpdateIfAlive(target);
    }

    /**
     * "Tap to install", for a download that finished out of sight.
     *
     * Static because the caller may be an activity that is parking the file
     * rather than the service that fetched it: whoever notices first posts it,
     * and both use the result id so a second post replaces instead of stacks.
     */
    static void notifyReady(Context context) {
        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pending = PendingIntent.getActivity(context, 2, open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_herdr)
                .setContentTitle(context.getString(R.string.update_ready_title))
                .setContentText(context.getString(R.string.update_ready_text))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(pending);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(RESULT_NOTIFICATION_ID, builder.build());
    }

    private void notifyProgress(int percent) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(percent));
    }

    private void notifyFailure(String reason) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_herdr)
                .setContentTitle(getString(R.string.update_failed_title))
                .setContentText(getString(R.string.update_failed_text))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(RESULT_NOTIFICATION_ID, builder.build());
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
        } finally { connection.disconnect(); }
    }

    private void download(String address, File target, String expected) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        connection.setRequestProperty("Accept-Encoding", "identity");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("Update download failed: " + status);
        String type = connection.getContentType();
        // The body is checked by a ZIP signature and the published digest. A
        // proxy or redirect may replace the content type on otherwise good
        // bytes, so it is not allowed to reject the file on its own.
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
            int last = -1;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) throw new UpdateFailure("too_large");
                output.write(buffer, 0, count);
                if (length > 0) {
                    int percent = (int) Math.min(99, total * 100 / length);
                    if (percent != last) { last = percent; DownloaderPlugin.State.set("downloading", "", percent); notifyProgress(percent); }
                }
            }
        } finally { connection.disconnect(); }
        if (!isZip(target)) throw new UpdateFailure("not_apk");
        if (!expected.equals(sha256(target))) throw new UpdateFailure("checksum");
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
        } catch (Exception error) { return false; }
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

    private static String failureReason(Exception error) {
        if (error instanceof UpdateFailure) return ((UpdateFailure) error).reason;
        if (error instanceof java.net.SocketTimeoutException
                || error instanceof java.net.UnknownHostException
                || error instanceof java.net.ConnectException
                || error instanceof javax.net.ssl.SSLException) return "network";
        if (error instanceof java.io.FileNotFoundException || error instanceof java.io.IOException) return "storage";
        return "network";
    }

    private static final class UpdateFailure extends Exception {
        final String reason;
        UpdateFailure(String reason) { this.reason = reason; }
    }

    private static void cleanup(File temporary) {
        try { if (temporary.exists()) temporary.delete(); } catch (Throwable ignored) { }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(R.string.update_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.update_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(int percent) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 1, open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_herdr)
                .setContentTitle(getString(R.string.update_title))
                .setContentText(getString(R.string.update_text, percent))
                .setProgress(100, percent, false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pending)
                .build();
    }

    @Override public void onTimeout(int startId, int fgsType) { stopSelf(startId); }
    @Override public void onTimeout(int startId) { stopSelf(startId); }
    @Override public IBinder onBind(Intent intent) { return null; }

    static void startFrom(Context context, String url, String checksumUrl, String version) {
        Intent intent = new Intent(context, UpdateDownloadService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_CHECKSUM_URL, checksumUrl)
                .putExtra(EXTRA_VERSION, version);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }
}
