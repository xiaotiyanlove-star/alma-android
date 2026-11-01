package local.almaandroid.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the WebView-side connection alive while the app is in the background.
 *
 * The JS layer already keeps running when the activity pauses (Capacitor does
 * not pause WebView timers), so the only thing needed natively is a foreground
 * service: it raises the process priority above the background-reclaim
 * threshold and keeps the network unrestricted. No networking happens here.
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("无法启动后台连接: " + error.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), KeepAliveService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject("无法停止后台连接: " + error.getMessage());
        }
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        call.resolve(new com.getcapacitor.JSObject().put("running", KeepAliveService.isRunning()));
    }
}
