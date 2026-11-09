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
public class MainActivity extends BridgeActivity implements DownloaderPlugin.Installer {

    /**
     * A weak reference is enough: the service owns the transfer, and must not
     * keep a destroyed Activity (and its whole WebView) alive just to hand it
     * an installer intent.
     */
    private static java.lang.ref.WeakReference<MainActivity> live;

    /**
     * The verified APK waiting for a foreground to hand to the installer.
     *
     * Android refuses to start an installer from the background. A download
     * that finishes while the user is elsewhere therefore leaves its file here,
     * shows a tap-to-install notification, and this activity installs it on the
     * next resume — including the resume caused by that notification.
     */
    static volatile File pendingInstall;

    /** Application context, used to post a notification with no activity up. */
    private static android.content.Context liveContext;

    /**
     * Whether an Alma window is currently in front.
     *
     * This is the condition that decides whether the installer can be started:
     * Android blocks activity launches from a background app, so the check has
     * to mirror the system's idea of foreground rather than "is the object
     * still allocated".
     */
    private static volatile boolean resumed;

    /**
     * Called by {@link UpdateDownloadService} after the APK has passed its
     * digest check. A null activity means the user was elsewhere; the page
     * shows the verified state on return and starts the installer then.
     */
    static boolean installUpdateIfAlive(File apk) {
        MainActivity activity = live == null ? null : live.get();
        // Being alive is not enough: Android refuses an activity launch from a
        // background app ("Background activity launch blocked"), and attempting
        // it left the finished download with no visible next step. Only a
        // resumed activity may drive the installer; anything else parks the file
        // and relies on the notification.
        if (activity == null || !resumed) {
            pendingInstall = apk;
            if (activity != null) UpdateDownloadService.notifyReady(activity);
            else if (liveContext != null) UpdateDownloadService.notifyReady(liveContext);
            return true;
        }
        activity.installUpdate(apk);
        return true;
    }

    /**
     * 与 renderer 的 --surface 一致。
     *
     * 这是 WebView 上下边距露出的那块底色，紧贴页面头部，所以要和页面表面
     * 同色（深色 #121614、浅色 #ffffff），而不是与更暗的页面底色一致。
     */
    private static final int BG_DARK = 0xFF121614;
    private static final int BG_LIGHT = Color.WHITE;

    private WebView webView;

    /**
     * 页面最后上报的主题偏好（"dark" | "light" | "system"）。
     *
     * 系统深浅色变化时不能直接按 isNightMode() 重设窗口：用户在应用内固定了
     * 深色，系统切到浅色不该把窗口底色刷白。
     */
    private String themeMode = "system";

    /** A consumed `alma://connect` link, waiting for a page that can take it. */
    private String pendingPairingLink;
    private android.webkit.PermissionRequest pendingCameraRequest;

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
            android.webkit.PermissionRequest pending = pendingCameraRequest;
            pendingCameraRequest = null;
            if (pending == null) return;
            try {
                if (granted) pending.grant(pending.getResources());
                else pending.deny();
            } catch (RuntimeException ignored) {
                // The user may have closed the scanner while the dialog was up.
            }
        });

    @Override
    public void onCreate(Bundle savedInstanceState) {
        live = new java.lang.ref.WeakReference<>(this);
        liveContext = getApplicationContext();
        registerPlugin(HerdrVaultPlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(LocalNetworkPlugin.class);
        registerPlugin(DownloaderPlugin.class);
        super.onCreate(savedInstanceState);

        webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            applyWebViewBackground(isNightMode());
            applyWindowBackground(isNightMode());
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
            // No upstream updater bridge: this fork has its own application identity.
        } catch (Throwable t) {
            // 同上
        }

        // A pairing link that launched the app. It is handed to the page once
        // the page is ready to receive it — a document-start script would run
        // before the controller exists — and never stored here.
        deliverPairingLink(getIntent());

        // 应用内自更新：下载完成后通过 FileProvider 拉起系统安装器。
        // v0.4.213-11 起弃用系统 DownloadManager：透明代理/部分 ROM 的
        // DownloadManager 会把 200 的 HTML 错误页当 APK 落盘（实机
        // 「安装包已损坏」，SUCCESSFUL ≠ 文件有效）。改为应用内
        // HttpURLConnection 直下：写盘前校验状态码/Content-Type/zip 魔数。
    }

    /**
     * Starts the system installer for a downloaded, verified release APK.
     *
     * The APK lives under this app's external files directory, which is the
     * only path the FileProvider exposes. Android shows its own confirmation
     * and applies the normal signature check, so a file that is not signed by
     * this app's key cannot replace it.
     */
    @Override
    public void installUpdate(File apk) {
        runOnUiThread(() -> {
            try {
                // A fresh install needs this switch once. Send the user to the
                // exact system page rather than failing with no explanation.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && !getPackageManager().canRequestPackageInstalls()) {
                    DownloaderPlugin.State.set("failed", "permission", 0);
                    Intent settings = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getPackageName()))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(settings);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception error) {
                // A missing installer on an oddly configured device must not
                // crash the app, but it must not look like a successful start.
                DownloaderPlugin.State.set("failed", "installer", 0);
            }
        });
    }

    /**
     * Runs the installer that a background download could not start.
     *
     * Android blocks an app from launching another activity while it is in the
     * background, so a finished download parks its file in
     * {@link #pendingInstall} and shows a tap-to-install notification. Both the
     * notification tap and an ordinary return to the app land here.
     */
    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        File waiting = pendingInstall;
        if (waiting == null) return;
        pendingInstall = null;
        installUpdate(waiting);
    }

    /**
     * A pairing link that arrived while the activity was already running.
     *
     * `singleTask` means a second `alma://connect` tap lands here rather than
     * starting a new activity; without this the link would be dropped.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverPairingLink(intent);
    }

    /**
     * Hands an `alma://connect?…` link to the page.
     *
     * The shell does not parse or validate the link: the page owns the pairing
     * rules (HTTPS relay, e2e flag, key shape), and duplicating them here would
     * create a second place for them to drift. Anything that is not a connect
     * link is ignored, so a stray `alma:` intent cannot pre-fill the form.
     *
     * The page may not have loaded yet when this runs from `onCreate`, so the
     * value is retried once the WebView finishes loading rather than being
     * written into a document that will be replaced.
     */
    private void deliverPairingLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"alma".equals(data.getScheme())) return;
        if (!"connect".equals(data.getHost())) return;
        final String link = data.toString();
        // Consumed once: a rotation or a resume must not re-fill the form.
        intent.setData(null);
        pendingPairingLink = link;
        postPairingLink();
    }

    /**
     * Tries the live bridge first and leaves the value for boot otherwise.
     *
     * The page is not necessarily loaded yet — from `onCreate` it usually is
     * not — so a failed call is the normal case, not an error: `main.tsx`
     * takes the pending value through the native bridge once the page exists.
     * The credential is kept in Java until that one-shot read, not copied onto
     * `window`, where unrelated scripts could inspect it.
     */
    private void postPairingLink() {
        final String link = pendingPairingLink;
        if (link == null || webView == null) return;
        final String script = "(function(){var b=window.__almaAndroidPairing;"
                + "if(typeof b==='function'){b(" + jsString(link) + ");return true}"
                + "return false})()";
        runOnUiThread(() -> {
            try {
                // `evaluateJavascript` answers with the JSON form of the value:
                // the literal `true`, not a Java boolean. The pending copy is
                // cleared only on that exact answer. Anything else — a page
                // that is not ready, a refused call — leaves it for the
                // one-shot boot read, which is the only other consumer.
                webView.evaluateJavascript(script, accepted -> {
                    if ("true".equals(accepted)) pendingPairingLink = null;
                });
            } catch (Throwable ignored) {
                // Still loading; the page picks the value up at boot.
            }
        });
    }

    String takePendingPairingLink() {
        String value = pendingPairingLink;
        pendingPairingLink = null;
        return value;
    }

    /**
     * A JSON string literal, safe to splice into a script.
     *
     * Delegates to the platform encoder rather than escaping by hand: a hand
     * written encoder has to remember every character JavaScript treats as a
     * line break (U+2028/U+2029 as well as \n and \r), and the value here is
     * a credential. `JSONObject.quote` handles the whole class at once.
     */
    private static String jsString(String value) {
        return org.json.JSONObject.quote(value);
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
                    if (pendingCameraRequest != null) pendingCameraRequest.deny();
                    pendingCameraRequest = request;
                    cameraPermission.launch(Manifest.permission.CAMERA);
                }
            }
        });
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        resumed = false;
        if (live != null && live.get() == this) live = null;
        // The file itself stays: it is the download the user asked for, and the
        // next launch installs it. Only the reference to a dead activity goes.
        android.webkit.PermissionRequest pending = pendingCameraRequest;
        pendingCameraRequest = null;
        if (pending != null) {
            try { pending.deny(); } catch (RuntimeException ignored) { }
        }
        super.onDestroy();
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

    /**
     * 窗口底色：状态栏/导航栏下方露出的就是它。
     *
     * WebView 按 systemBars 做了上下边距，那两条边距显示的是父容器
     * (CoordinatorLayout) 的背影，不是页面。父容器原先继承主题里的启动色，
     * 只在 **系统** 深色时才是深色；应用内手动选深色而系统是浅色时，边距仍
     * 为白色 —— 深色页面上下各一条白边，浅色的状态栏图标画在白色上等于看不见。
     *
     * 所以要改的是 webView 的父容器，而不是 android.R.id.content：
     * 后者在 Capacitor 的布局里是另一个视图，改了也盖不住父容器。
     */
    private void applyWindowBackground(boolean dark) {
        int color = dark ? BG_DARK : BG_LIGHT;
        try {
            getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(color));
            getWindow().getDecorView().setBackgroundColor(color);
            View root = findViewById(android.R.id.content);
            if (root != null) root.setBackgroundColor(color);
            // The strips above and below the WebView are painted by its parent.
            if (webView != null && webView.getParent() instanceof View) {
                ((View) webView.getParent()).setBackgroundColor(color);
            }
        } catch (Throwable t) {
            // 个别 ROM 上设置窗口背景失败不影响功能
        }
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
    private boolean themeIsDark() {
        return "dark".equals(themeMode) || (!"light".equals(themeMode) && isNightMode());
    }

    private void applyTheme(String mode) {
        themeMode = mode == null ? "system" : mode;
        boolean dark = themeIsDark();
        applyWebViewBackground(dark);
        applyWindowBackground(dark);
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
        // Follow the in-app choice when there is one; only "system" reacts here.
        applyWebViewBackground(themeIsDark());
        applyWindowBackground(themeIsDark());
        applySystemBars(themeIsDark());
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

        /**
         * Hands the page a pairing link it may not have been able to receive
         * yet, then forgets it. Called once from `main.tsx` at boot.
         *
         * Empty string means "nothing waiting", so the page can skip the parse
         * without having to know about null.
         */
        @JavascriptInterface
        public String takePairingLink() {
            String value = takePendingPairingLink();
            return value == null ? "" : value;
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
