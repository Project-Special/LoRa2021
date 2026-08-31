import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

/**
 * Plugin nativo de serial USB deste app.
 *
 * A implementação está em android/.../UsbSerialPlugin.java, portada do projeto
 * Android/serial_usb — o único destes projetos com serial funcionando neste
 * aparelho. O que ele faz de diferente é DESCOBRIR o conversor com
 * UsbSerialProber em vez de tentar uma lista fixa de VID/PID.
 */
export interface UsbSerialPlugin {
  /**
   * O que está plugado. Os dois contadores existem porque "há USB mas nenhum é
   * serial" e "não há USB nenhum" pedem ações diferentes: cabo errado contra
   * nada conectado.
   */
  listDevices(): Promise<{
    usbCount: number;
    serialCount: number;
    devices: string;
    driver?: string;
    vid?: string;
    pid?: string;
  }>;

  /**
   * Segura a tela ligada enquanto uma campanha grava.
   *
   * Nao e conforto: em aparelhos Samsung o bloqueio de tela ATIVA o
   * UsbHostRestrictor, que corta o modo host do USB. A serial morre junto, com
   * a placa ligada e o cabo no lugar. Ver o comentario em UsbSerialPlugin.java.
   */
  manterTelaAtiva(options: { on: boolean }): Promise<{ success: boolean }>;

  /**
   * GET no painel do ESP32, forcado pela interface WiFi.
   *
   * Precisa ser nativo: da WebView (https://localhost) um fetch em
   * http://192.168.4.1 e conteudo misto, e o Android ainda mandaria a conexao
   * pelos dados moveis, onde esse endereco nao existe.
   */
  espGet(options: { url: string }): Promise<{ status: number; body: string }>;

  requestPermission(): Promise<{ granted: boolean }>;
  open(options: { baudRate: number }): Promise<{ success: boolean; driver?: string }>;
  write(options: { data: string }): Promise<{ success: boolean }>;
  close(): Promise<{ success: boolean }>;

  addListener(
    event: 'serialData',
    cb: (ev: { data: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'serialError',
    cb: (ev: { error: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const UsbSerial = registerPlugin<UsbSerialPlugin>('UsbSerial');
export default UsbSerial;
