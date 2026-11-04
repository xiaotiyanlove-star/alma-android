package local.almaandroid.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

/**
 * Reports the networks this phone is actually attached to.
 *
 * The local-network path exists only because direct connections speak plain
 * `ws://`. Letting the WebView reach any address over plain text would mean
 * the app can be pointed at a stranger's host; restricting it to "private
 * ranges" is better but still broad. The phone already knows exactly which
 * subnets it is on, so that is the boundary: an address is acceptable only if
 * it sits on the same subnet as one of this device's own interfaces.
 *
 * The WebView cannot answer this. `navigator.connection` reports a link
 * quality, not an address, and Chrome removed the interface type entirely.
 * {@link ConnectivityManager} is the only source, which is why this lives in
 * Java rather than in the page.
 */
@CapacitorPlugin(name = "LocalNetwork")
public class LocalNetworkPlugin extends Plugin {

    /**
     * Every IPv4 subnet the device currently has an address on.
     *
     * Only Wi-Fi and Ethernet links are reported: those are the transports a
     * shared local network can appear on. Cellular is excluded because a
     * carrier APN also hands out 10.x addresses, and scanning one is neither
     * useful nor appropriate.
     */
    @PluginMethod
    public void subnets(PluginCall call) {
        JSArray subnets = new JSArray();
        try {
            for (LinkAddress link : currentLinkAddresses()) {
                InetAddress address = link.getAddress();
                if (!(address instanceof Inet4Address)) continue;
                JSObject entry = new JSObject();
                entry.put("address", address.getHostAddress());
                entry.put("prefixLength", link.getPrefixLength());
                subnets.put(entry);
            }
        } catch (Exception error) {
            // Nothing reachable is a valid answer: it means no direct path, and
            // the caller falls back to the relay.
            call.reject("Could not read local networks", error);
            return;
        }
        JSObject result = new JSObject();
        result.put("subnets", subnets);
        call.resolve(result);
    }

    private List<LinkAddress> currentLinkAddresses() {
        List<LinkAddress> found = new ArrayList<>();
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return found;

        Network active = manager.getActiveNetwork();
        if (active != null) collect(manager, active, found);

        // A Wi-Fi/cellular handover can leave the new network not yet "active"
        // for a moment; collecting all of them means a check during that
        // window does not wrongly report "no local network".
        for (Network network : manager.getAllNetworks()) {
            if (active != null && network.equals(active)) continue;
            collect(manager, network, found);
        }
        return found;
    }

    private void collect(ConnectivityManager manager, Network network, List<LinkAddress> into) {
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        // A carrier's private APN can also be 10.x/192.168.x, but it is not the
        // local network the user means and must not trigger a /24 scan. Wi-Fi
        // and Ethernet are the only transports that can represent a shared LAN.
        if (capabilities == null || (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return;
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null) return;
        for (LinkAddress address : properties.getLinkAddresses()) {
            if (address.getAddress() instanceof Inet4Address && !into.contains(address)) into.add(address);
        }
    }
}
