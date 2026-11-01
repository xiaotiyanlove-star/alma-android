package local.almaandroid.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "HerdrVault")
public class HerdrVaultPlugin extends Plugin {
    private static final String ALIAS = "herdr.remote.pairings.v1";
    private AtomicFile file() {
        return new AtomicFile(new File(getContext().getNoBackupFilesDir(), "herdr-pairings.enc"));
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("Encryption key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }
    @PluginMethod
    public synchronized void load(PluginCall call) {
        try {
            AtomicFile target = file();
            JSObject result = new JSObject();
            if (!target.getBaseFile().exists()) { result.put("value", org.json.JSONObject.NULL); call.resolve(result); return; }
            byte[] data = target.readFully();
            if (data.length < 29 || data.length > 262144) throw new IllegalStateException("Invalid vault");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12)));
            result.put("value", new String(cipher.doFinal(Arrays.copyOfRange(data, 12, data.length)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("Unable to read encrypted node storage"); }
    }
    @PluginMethod
    public synchronized void save(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.length() > 65536) { call.reject("Invalid node storage"); return; }
        AtomicFile target = file();
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            output = target.startWrite();
            output.write(cipher.getIV());
            output.write(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)));
            target.finishWrite(output);
            call.resolve();
        } catch (Exception error) {
            if (output != null) target.failWrite(output);
            call.reject("Unable to save encrypted node storage");
        }
    }
}
