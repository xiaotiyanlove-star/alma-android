package local.almaandroid.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.Locale;

/**
 * Alma Android 壳。
 * <p>
 * 原生侧职责（等价官方 iOS 壳）：
 * <ul>
 *   <li>WebView 权限：配对扫码用 getUserMedia 拿摄像头。Capacitor 的
 *       WebChromeClient 在 App 已持有运行时权限时会放行 WebView 的
 *       PermissionRequest —— 所以这里在启动时主动申请 CAMERA。</li>
 *   <li>首帧背景色与页面一致，减少启动白闪（暗色 = #282c34，随系统/应用主题）。</li>
 *   <li>edge-to-edge（Android 15 强制 / 部分 ROM 自行全屏）：系统栏图标
 *       深浅随主题，键盘 insets 由父容器补齐。</li>
 *   <li>注入系统 locale（renderer 语言检测用；WebView 的 navigator.language
 *       不随系统语言，需要原生权威值）。</li>
 * </ul>
 */
public class MainActivity extends BridgeActivity {

    /** 与 renderer 主题底色一致（shim 的 FOUC 打底同色）。 */
    private static final int BG_DARK = 0xFF282C34;
    private static final int BG_LIGHT = Color.WHITE;

    private WebView webView;

    /** Set while the page is waiting for the user to pick files. */
    private android.webkit.ValueCallback<Uri[]> pendingFileChooser;
    private static final int FILE_CHOOSER_REQUEST = 4711;

    /** 下载状态（shim 轮询进度用）：none|downloading|failed。 */
    /** 下载代次号：新一轮 downloadAndInstall 使旧线程的镜像重试链失效。 */
    /** 镜像重试队列（按序换：下载失败 / 文件无效时取下一个）。 */

    /** Returns the picked document(s) to the WebView's <input type="file">. */
    private final androidx.activity.result.ActivityResultLauncher<Intent> fileChooser =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            android.webkit.ValueCallback<Uri[]> callback = pendingFileChooser;
            pendingFileChooser = null;
            if (callback == null) return;
            callback.onReceiveValue(collectUris(result));
        });

    private Uri[] collectUris(androidx.activity.result.ActivityResult result) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            return null;
        }
        Intent data = result.getData();
        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            Uri[] uris = new Uri[count];
            for (int i = 0; i < count; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
            return uris;
        }
        Uri single = data.getData();
        return single == null ? null : new Uri[]{single};
    }

    /**
     * Capacitor's WebChromeClient does not implement onShowFileChooser, so a
     * page's <input type="file"> does nothing on Android. Open the system
     * picker and hand the chosen URIs back.
     */
    private boolean showFileChooser(android.webkit.ValueCallback<Uri[]> callback, android.webkit.WebChromeClient.FileChooserParams params) {
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
        }
        pendingFileChooser = callback;
        try {
            Intent intent = params.createIntent();
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // getMode() is an int constant, not an enum; MODE_OPEN_MULTIPLE
            // corresponds to the page's `multiple` attribute.
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
            fileChooser.launch(intent);
            return true;
        } catch (Exception error) {
            pendingFileChooser = null;
            callback.onReceiveValue(null);
            return false;
        }
    }

    private final androidx.activity.result.ActivityResultLauncher<String> cameraPermission =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            // The next getUserMedia call re-enters the bridge once the user answers.
        });

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrVaultPlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);

        webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            applyWebViewBackground(isNightMode());
            applySystemBars(isNightMode());
            attachImeInsetsListener();
            allowLandscapeCutout();
            attachAppInsets();
            installCameraBridge();
        }

        createAlertChannel();
        // Camera is requested lazily when the user opens the QR scanner, so
        // node setup by pasting a link never needs it.

        // 系统语言：Android WebView 的 navigator.language 不随系统语言（Capacitor
        // 长期已知问题，常返 en-US），renderer 的语言检测因此误判。原生侧提供权威
        // locale：documentStart 脚本（API 33+）在任何页面 JS 之前注入主帧与 iframe；
        // 旧设备回退 JavascriptInterface，由 shim 同步读取。二者皆无时 shim 退回
        // navigator.language。
        String langScript = "window.__almaAndroidLang__=\"" + Locale.getDefault().toLanguageTag() + "\";";
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                java.util.Set<String> origins = new java.util.HashSet<>(java.util.Arrays.asList(
                        "https://localhost", "http://localhost"));
                WebViewCompat.addDocumentStartJavaScript(webView, langScript, origins);
            }
        } catch (Throwable t) {
            // 不支持则静默降级到 JavascriptInterface
        }
        try {
            webView.addJavascriptInterface(new LocaleBridge(), "__almaAndroidLocale");
            webView.addJavascriptInterface(new UiBridge(), "__almaAndroidUi");
            webView.addJavascriptInterface(new BackBridge(), "__herdrExitApp");
            // No upstream updater bridge: this fork has its own application identity.
        } catch (Throwable t) {
            // 同上
        }

        // 应用内自更新：下载完成后通过 FileProvider 拉起系统安装器。
        // v0.4.213-11 起弃用系统 DownloadManager：透明代理/部分 ROM 的
        // DownloadManager 会把 200 的 HTML 错误页当 APK 落盘（实机
        // 「安装包已损坏」，SUCCESSFUL ≠ 文件有效）。改为应用内
        // HttpURLConnection 直下：写盘前校验状态码/Content-Type/zip 魔数。
    }

    /**
     * Notification channel for "agent needs you" alerts. Must exist before the
     * first schedule() call or Android silently drops the notification.
     */
    private void createAlertChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
            if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.alert_channel_name),
                    android.app.NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription(getString(R.string.alert_channel_description));
            channel.enableVibration(true);
            manager.createNotificationChannel(channel);
        } catch (Throwable t) {
            // A missing channel only silences alerts; never block startup.
        }
    }


    /**
     * Capacitor owns the WebChromeClient. Wrap it so a camera request is
     * granted immediately when the runtime permission already exists; a
     * pending activity-result round trip can otherwise leave getUserMedia
     * waiting forever.
     */
    private void installCameraBridge() {
        if (webView == null) return;
        final android.webkit.WebChromeClient original = webView.getWebChromeClient();
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
                return showFileChooser(callback, params);
            }

            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                boolean wantsVideo = false;
                for (String resource : request.getResources()) {
                    if (resource.contains("VIDEO_CAPTURE")) wantsVideo = true;
                }
                if (!wantsVideo) {
                    if (original != null) original.onPermissionRequest(request);
                    else request.deny();
                    return;
                }
                boolean granted = ContextCompat.checkSelfPermission(MainActivity.this,
                        Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                if (granted) {
                    request.grant(request.getResources());
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA);
                    request.deny();
                }
            }
        });
    }

    private static final String CHANNEL_ID = "herdr-alerts";

    // ── 主题底色 / 系统栏外观 ────────────────────────────────────────────

    private boolean isNightMode() {
        int ui = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return ui == Configuration.UI_MODE_NIGHT_YES;
    }

    /** WebView 底色：页面尚未绘制/重载时的兜底，必须与主题一致，否则暗色用户看到白闪。 */
    private void applyWebViewBackground(boolean dark) {
        if (webView != null) webView.setBackgroundColor(dark ? BG_DARK : BG_LIGHT);
    }

    /** 状态栏/导航栏图标深浅（dark=true 表示页面深色 → 图标用浅色）。 */
    private void applySystemBars(boolean dark) {
        try {
            WindowInsetsControllerCompat c = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
            c.setAppearanceLightStatusBars(!dark);
            c.setAppearanceLightNavigationBars(!dark);
        } catch (Throwable t) {
            // 个别 ROM 上调整失败不影响功能
        }
    }

    /** 应用主题（"dark" | "light" | "system"）→ WebView 底色 + 系统栏图标。 */
    private void applyTheme(String mode) {
        boolean dark = "dark".equals(mode) || (!"light".equals(mode) && isNightMode());
        applyWebViewBackground(dark);
        applySystemBars(dark);
    }

    /**
     * 键盘 insets：edge-to-edge 下 Capacitor 只给 WebView 补 systemBars 边距并在
     * WebView 上 CONSUMED 全部 insets（含 ime）→ 键盘弹出会盖住输入框。在 WebView
     * 的父容器上按 ime 补底 padding（减去已由 WebView margin 处理的导航栏高度），
     * insets 继续透传给 WebView 供 Capacitor 使用。非 edge-to-edge 窗口 insets
     * 派发到这里已是 0，此监听为 no-op。
     */
    private void attachImeInsetsListener() {
        if (!(webView.getParent() instanceof View)) return;
        View parent = (View) webView.getParent();
        ViewCompat.setOnApplyWindowInsetsListener(parent, (v, insets) -> {
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(0, 0, 0, Math.max(0, ime.bottom - bars.bottom));
            return insets;
        });
    }

    /**
     * 横屏挖孔全屏铺满（修复横屏左/右侧被挖孔逼出的空白条）。
     * <p>Android ≤14 默认 layoutInDisplayCutoutMode 在横屏下整个窗口避让挖孔
     * （系统级 letterbox）；shortEdges 允许窗口延伸进挖孔区，与 Android 15
     * edge-to-edge 强制行为一致。无挖孔设备（含 AVD 默认）此设置无任何效果。
     */
    private void allowLandscapeCutout() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                getWindow().getAttributes().layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            } catch (Throwable t) {
                // 个别 ROM 不接受则维持系统默认
            }
        }
    }

    /**
     * 用应用自己的 insets 策略替换 Capacitor 的 WebView 边距
     * （adjustMarginsForEdgeToEdge=force：边距 = systemBars|displayCutout 并集）。
     * <p>差异只在横屏左右：挖孔屏左右侧的 displayCutout inset（OPPO 打孔在横屏
     * 落在左缘，实测 136px）不再折算成 WebView 左右边距 —— 那会得到一条内容
     * 永远进不去的空白条。聊天内容在孔下滚动是全屏应用的常态；上下仍取
     * systemBars 与 displayCutout 的较大者，竖屏刘海/状态栏行为不变。
     * setOnApplyWindowInsetsListener 直接顶掉 Capacitor 在 Bridge 构造时挂的
     * 监听（本方法在 super.onCreate 之后调用）。
     */
    private void attachAppInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            if (v.getLayoutParams() instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
                mlp.leftMargin = bars.left;
                mlp.rightMargin = bars.right;
                mlp.topMargin = Math.max(bars.top, cut.top);
                mlp.bottomMargin = Math.max(bars.bottom, cut.bottom);
                v.setLayoutParams(mlp);
            }
            // 与 Capacitor 原监听一致：insets 不再下传（父容器的键盘补边在先执行）
            return WindowInsetsCompat.CONSUMED;
        });
        webView.requestApplyInsets();
    }

    /** uiMode 在 manifest 的 configChanges 里：系统深浅色切换不重建 Activity，手动同步。 */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyWebViewBackground(isNightMode());
        applySystemBars(isNightMode());
    }

    /** 兜底 locale 通道：documentStart 不可用（<API 33）时由 shim 同步调用。 */
    public static class LocaleBridge {
        @JavascriptInterface
        public String getLanguageTag() {
            return Locale.getDefault().toLanguageTag();
        }
    }

    /**
     * 主题通道：shim 在启动时（appearance-cache）与每次主题切换时上报
     * "dark"/"light"/"system"，原生同步 WebView 底色与系统栏图标深浅 ——
     * 应用内主题（含"跟随系统"）与系统深浅色不一致时也能保持对比度。
     */
    public class UiBridge {
        @JavascriptInterface
        public void setTheme(final String mode) {
            runOnUiThread(() -> applyTheme(mode));
        }
    }

    /**
     * 返回键。层级优先级（v0.4.213-11 修正：原先 canGoBack() 判在 JS 之前，
     * renderer 主页面积累过 pushState 历史后（用几天的真机必然如此），
     * 返回手势全被 WebView.goBack() 吃掉，设置层/弹窗的消化逻辑没机会
     * 跑 —— 实机表现为「配对页侧滑直接退出应用」回归）：
     * ① JS 消化（更新弹窗 → 设置层 iframe 内部回退 → 关设置层）；
     * ② WebView 自身历史（renderer 模态等 pushState）；
     * ③ 默认行为（退出）。
     */
    /** Exposed to the page so it can close the app once its own stack is empty. */
    public class BackBridge {
        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> MainActivity.this.finish());
        }
    }

    @Override
    public void onBackPressed() {
        WebView wv = webView != null ? webView
                : (getBridge() != null ? getBridge().getWebView() : null);
        if (wv != null) {
            // evaluateJavascript 的回调在 UI 线程执行
            wv.evaluateJavascript(
                "(window.__almaAndroidBack ? window.__almaAndroidBack() : false)",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("true".equals(value)) return; // JS 已按层级消化
                        if (wv.canGoBack()) {
                            wv.goBack();
                            return;
                        }
                        MainActivity.super.onBackPressed();
                    }
                });
            return;
        }
        super.onBackPressed();
    }
}
