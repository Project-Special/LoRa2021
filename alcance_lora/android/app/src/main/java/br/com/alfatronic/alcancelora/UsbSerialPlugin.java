package br.com.alfatronic.alcancelora;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;

/**
 * Serial USB para o app de alcance.
 *
 * Portado do projeto Android/serial_usb, que é o único destes projetos com
 * serial funcionando de verdade neste aparelho. O que faz a diferença ali, e
 * que as tentativas anteriores não tinham, é NÃO ADIVINHAR o dispositivo:
 * UsbSerialProber varre o que está conectado e escolhe o driver. Listas fixas
 * de VID/PID só funcionam para os conversores que alguém lembrou de listar.
 *
 * O que foi ACRESCENTADO em relação ao original: leitura. Lá o plugin só
 * escreve — suficiente para mandar comandos a um Arduino, inútil aqui, onde o
 * app existe para receber telemetria.
 */
@CapacitorPlugin(name = "UsbSerial")
public class UsbSerialPlugin extends Plugin implements SerialInputOutputManager.Listener {
    private static final String TAG = "UsbSerialPlugin";
    private static final String ACTION_USB_PERMISSION = "br.com.alfatronic.alcancelora.USB_PERMISSION";

    private UsbSerialPort serialPort;
    private UsbManager usbManager;
    private SerialInputOutputManager ioManager;

    @Override
    public void load() {
        super.load();
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    /** Lista o que está plugado — inclusive o que não tem driver serial. */
    @PluginMethod
    public void listDevices(PluginCall call) {
        HashMap<String, UsbDevice> all = usbManager.getDeviceList();
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);

        StringBuilder info = new StringBuilder();
        for (UsbDevice d : all.values()) {
            info.append(String.format("%04X:%04X %s\n",
                    d.getVendorId(), d.getProductId(), d.getProductName()));
        }

        JSObject ret = new JSObject();
        // Os dois números separados: "há USB mas nenhum é serial" e "não há USB
        // nenhum" são problemas diferentes — cabo errado contra nada plugado.
        ret.put("usbCount", all.size());
        ret.put("serialCount", drivers.size());
        ret.put("devices", info.toString().trim());
        if (!drivers.isEmpty()) {
            UsbDevice d = drivers.get(0).getDevice();
            ret.put("driver", drivers.get(0).getClass().getSimpleName());
            ret.put("vid", String.format("%04X", d.getVendorId()));
            ret.put("pid", String.format("%04X", d.getProductId()));
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
        if (drivers.isEmpty()) {
            call.reject("Nenhum conversor serial encontrado. Cabo OTG conectado?");
            return;
        }

        UsbDevice device = drivers.get(0).getDevice();
        if (usbManager.hasPermission(device)) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        Intent intent = new Intent(ACTION_USB_PERMISSION);
        // Intent explícito: exigência do Android 14+, sem isto o broadcast não
        // chega de volta e a promessa fica pendurada para sempre.
        intent.setPackage(getContext().getPackageName());

        PendingIntent pi = PendingIntent.getBroadcast(
                getContext(), 0, intent,
                PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        getContext().registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent it) {
                if (!ACTION_USB_PERMISSION.equals(it.getAction())) return;
                synchronized (this) {
                    boolean granted = it.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                    JSObject ret = new JSObject();
                    ret.put("granted", granted);
                    if (granted) call.resolve(ret);
                    else call.reject("Permissão do cabo negada");
                    ctx.unregisterReceiver(this);
                }
            }
        }, new IntentFilter(ACTION_USB_PERMISSION), Context.RECEIVER_NOT_EXPORTED);

        usbManager.requestPermission(device, pi);
    }

    /**
     * GET no painel do ESP32, FORCADO pela interface WiFi.
     *
     * Duas coisas impedem um fetch() comum de chegar la:
     *
     * 1. A WebView do Capacitor serve de https://localhost, e buscar
     *    http://192.168.4.1 dali e conteudo misto -- bloqueado pelo navegador.
     *    Indo pelo nativo, nao ha origem https para violar.
     *
     * 2. O AP do ESP32 nao da internet. O Android mantem os dados moveis como
     *    rede padrao, e uma conexao sem rota explicita sai por eles -- onde
     *    192.168.4.1 nao existe. Por isso a conexao e aberta a partir do objeto
     *    Network do WiFi: e o que amarra o socket a interface certa.
     *
     * Amarra por CONEXAO, nao o processo inteiro (bindProcessToNetwork). Assim
     * os dados moveis continuam disponiveis para a sincronizacao com a nuvem,
     * que precisa acontecer durante a mesma campanha.
     */
    @PluginMethod
    public void espGet(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url ausente");
            return;
        }
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            Network wifi = null;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    wifi = n;
                    break;
                }
            }
            if (wifi == null) {
                call.reject("nenhuma rede WiFi ativa");
                return;
            }

            java.net.HttpURLConnection conn =
                    (java.net.HttpURLConnection) wifi.openConnection(new java.net.URL(url));
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            conn.setRequestMethod("GET");

            int status = conn.getResponseCode();
            java.io.InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int k;
            while (is != null && (k = is.read(b)) > 0) out.write(b, 0, k);
            conn.disconnect();

            JSObject r = new JSObject();
            r.put("status", status);
            r.put("body", out.toString("UTF-8"));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("falha ao falar com o painel: " + e.getMessage());
        }
    }

    /**
     * Segura a tela ligada. Mora no plugin de SERIAL de proposito.
     *
     * Em aparelhos Samsung o bloqueio de tela dispara o UsbHostRestrictor, que
     * corta o modo host do USB -- o log do aparelho mostra a sequencia inteira:
     *
     *     UsbHostRestrictor: enterRestriction: Screen Lock On
     *     USB HOST UEVENT : STATE=REMOVE
     *     [diag] leitura: USB get_status request failed
     *
     * Ou seja: a serial morre com a placa ligada e o cabo no lugar. Numa
     * campanha de alcance isso e perder a medida no meio do caminho. Enquanto
     * grava, a tela fica acesa; e o unico jeito de o app garantir o USB por
     * conta propria, sem depender de o operador achar a opcao do sistema.
     */
    @PluginMethod
    public void manterTelaAtiva(PluginCall call) {
        final boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        JSObject r = new JSObject();
        r.put("success", true);
        call.resolve(r);
    }

    @PluginMethod
    public void open(PluginCall call) {
        // 420000: o baud unico do projeto. O JS manda explicito, mas um default
        // divergente seria uma armadilha para quem chamasse sem o parametro.
        int baudRate = call.getInt("baudRate", 420000);

        // Abrir por cima de uma porta ja aberta e o que produzia
        // "Queueing USB request failed": a segunda abertura reivindica a mesma
        // interface e derruba a leitura da primeira. O lado JS agora serializa
        // as chamadas, mas o plugin nao pode depender disso -- ele e quem
        // detem o recurso, entao e ele quem garante que so ha uma porta.
        fecharPorta();

        try {
            List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
            if (drivers.isEmpty()) {
                call.reject("Nenhum conversor serial encontrado");
                return;
            }

            UsbSerialDriver driver = drivers.get(0);
            UsbDeviceConnection connection = usbManager.openDevice(driver.getDevice());
            if (connection == null) {
                call.reject("Não abriu a conexão — permissão do cabo concedida?");
                return;
            }

            serialPort = driver.getPorts().get(0);
            serialPort.open(connection);
            serialPort.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            // DTR e RTS altos: vários conversores mantêm o alvo em reset sem
            // isso, e a porta abre sem nunca receber um byte.
            try {
                serialPort.setDTR(true);
                serialPort.setRTS(true);
            } catch (Exception ignored) {
                // Nem todo driver suporta; não é motivo para falhar a abertura.
            }

            // Leitura numa thread própria. Esta parte não existe no plugin
            // original — lá só se escreve.
            ioManager = new SerialInputOutputManager(serialPort, this);
            ioManager.start();

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("driver", driver.getClass().getSimpleName());
            call.resolve(ret);
        } catch (IOException e) {
            Log.e(TAG, "erro ao abrir", e);
            call.reject("Erro ao abrir: " + e.getMessage());
        }
    }

    /** Solta ioManager e porta, se houver. Silencioso e idempotente. */
    private void fecharPorta() {
        if (ioManager != null) {
            try { ioManager.stop(); } catch (Exception ignored) { }
            ioManager = null;
        }
        if (serialPort != null) {
            try { serialPort.close(); } catch (Exception ignored) { }
            serialPort = null;
        }
    }

    @Override
    public void onNewData(byte[] data) {
        // Os bytes sobem em Base64, sem interpretação.
        //
        // Antes subiam como String(data, UTF_8), e isso funcionava enquanto a
        // placa falava o texto da bancada. O receptor ExpressLRS fala CRSF
        // binário: decodificar como UTF-8 troca toda sequência inválida por
        // U+FFFD, ou seja, DESTRÓI o quadro antes de o JS o ver. O app lia o
        // cabo inteiro e continuava dizendo "sem enlace".
        //
        // Base64 custa 33% de banda na ponte e devolve os bytes intactos. O
        // lado JS decodifica e alimenta os dois leitores: o de quadros CRSF e
        // o de linhas de texto, que continua servindo à bancada.
        JSObject ev = new JSObject();
        ev.put("data", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP));
        notifyListeners("serialData", ev);
    }

    @Override
    public void onRunError(Exception e) {
        Log.e(TAG, "erro de leitura", e);
        JSObject ev = new JSObject();
        ev.put("error", e.getMessage());
        notifyListeners("serialError", ev);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String data = call.getString("data");
        if (serialPort == null) {
            call.reject("Porta não está aberta");
            return;
        }
        try {
            serialPort.write(data.getBytes(StandardCharsets.UTF_8), 1000);
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("Erro ao escrever: " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (ioManager != null) {
            ioManager.stop();
            ioManager = null;
        }
        if (serialPort != null) {
            try {
                serialPort.close();
            } catch (IOException e) {
                Log.e(TAG, "erro ao fechar", e);
            }
            serialPort = null;
        }
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }
}
