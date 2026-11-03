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
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service that exists only to keep the host process alive and its
 * socket unrestricted while the app is in the background. It deliberately does
 * no work of its own: the connection, the state diff and the notifications all
 * live in the WebView.
 */
public class KeepAliveService extends Service {

    static final String CHANNEL_ID = "herdr-keepalive";
    static final int NOTIFICATION_ID = 7101;
    /**
     * Whether this service may run at all.
     *
     * A foreground service *must* show a notification; Android shows it even
     * with the POST_NOTIFICATIONS permission denied. There is no supported way
     * to make it invisible, so the setting really chooses between "something is
     * always in the shade" and "nothing is kept alive in the background".
     */
    static volatile boolean enabled = false;

    private static volatile boolean running = false;

    static boolean isRunning() { return running; }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    /**
     * Android 15 caps `dataSync` foreground services at six hours in any
     * 24-hour window. When the cap is reached the system calls this and then
     * kills the process if the service is still running, so it has to stop
     * itself. The connection then falls back to the normal lifecycle rules.
     *
     * `onTimeout(int, int)` was added in API 35; the single-argument form
     * exists since API 24 for short services. Both are overridden because the
     * class cannot reference the newer signature on older devices at compile
     * time without an API check.
     */
    @Override
    public void onTimeout(int startId) {
        running = false;
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.keepalive_channel_name),
                NotificationManager.IMPORTANCE_MIN);
        channel.setDescription(getString(R.string.keepalive_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, open,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                        : PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_herdr)
                .setContentTitle(getString(R.string.keepalive_title))
                .setContentText(getString(R.string.keepalive_text))
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(pending);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Collapsed to a single line rather than expanded, and placed with
            // the other ongoing entries rather than at the top.
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED);
        }
        return builder.build();
    }

    /** Stops immediately when the user has turned background keeping off. */
    static void stopFrom(Context context) {
        context.stopService(new Intent(context, KeepAliveService.class));
    }

    static void startFrom(Context context) {
        Intent intent = new Intent(context, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }
}
