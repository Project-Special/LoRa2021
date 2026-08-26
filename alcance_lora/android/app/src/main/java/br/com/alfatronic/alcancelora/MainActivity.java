package br.com.alfatronic.alcancelora;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int REQ_NOTIF = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin proprio: precisa ser registrado ANTES do super, senao a ponte
        // ja subiu e o JS nao encontra "UsbSerial".
        registerPlugin(UsbSerialPlugin.class);
        super.onCreate(savedInstanceState);
        askNotificationPermission();
    }

    /**
     * Permissao de notificacao, exigida a partir do Android 13.
     *
     * A coleta em segundo plano roda num servico em primeiro plano, e o servico
     * PRECISA de uma notificacao visivel. Sem esta permissao o servico ainda
     * sobe, mas o usuario perde o unico sinal de que a campanha esta gravando —
     * e num teste de alcance de uma hora, descobrir no fim que nao gravou custa
     * a caminhada inteira.
     */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
    }
}
