package br.com.alfatronic.alcancelora;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.util.Log;

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

    @PluginMethod
    public void open(PluginCall call) {
        int baudRate = call.getInt("baudRate", 115200);
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

    @Override
    public void onNewData(byte[] data) {
        // Os bytes sobem como texto. A telemetria do firmware é ASCII, e assim
        // o lado JS só precisa quebrar em linhas.
        JSObject ev = new JSObject();
        ev.put("data", new String(data, StandardCharsets.UTF_8));
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
