import { RadioState } from '../types';
import { Diag } from './Diag';

/**
 * Lê o rádio pela SERIAL USB da placa.
 *
 * O firmware emite, a cada 5 s e sob o comando `tel`, uma linha de telemetria
 * com prefixo fixo:
 *
 *   $T t=15838 link=1 rssi=-36.0 snr=12.2 lq=100 rx=9 lost=0 freq=433.000
 *      band=433 sf=9 bw=125.00 pwr=22 role=rx
 *
 * O prefixo existe para conviver com o resto do log: qualquer linha que não
 * comece com "$T " é ignorada, então mensagens de diagnóstico no meio não
 * quebram o parser.
 *
 * Por que serial e não o painel web: pelo AP da placa o celular fica sem
 * internet, e um teste de alcance de uma hora inteira offline é ruim. Por USB
 * os dados móveis continuam de pé.
 *
 * São dois transportes com a mesma interface — o plugin do Capacitor no
 * Android, e a Web Serial no navegador de mesa, que é onde se desenvolve. A
 * Web Serial não existe no Chrome do Android, e é por isso que o plugin
 * precisa existir.
 */

/**
 * O MESMO baud do resto do projeto.
 *
 * 420000 vem do CRSF do ExpressLRS, que e fixo. Alinhar a bancada nele acaba
 * com a adivinhacao: qualquer ferramenta abre em 420000 e conversa com
 * qualquer uma das duas placas, seja ela bancada ou receptor ELRS.
 */
const BAUD = 420000;

export interface SerialTransport {
  readonly name: string;
  isAvailable(): boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Chamado a cada linha completa recebida. */
  onLine(cb: (line: string) => void): void;
  write(text: string): Promise<void>;
}

/** Quebra um fluxo de bytes em linhas, guardando o resto entre chamadas. */
class LineSplitter {
  private buf = '';
  constructor(private readonly emit: (line: string) => void) {}
  push(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line) this.emit(line);
    }
    // Linha gigante sem quebra é sinal de lixo binário; não vale guardar.
    if (this.buf.length > 4096) this.buf = '';
  }
}

/** Web Serial — navegador de mesa. Serve para desenvolver sem o celular. */
class WebSerialTransport implements SerialTransport {
  readonly name = 'Web Serial';
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private cb: ((line: string) => void) | null = null;
  private closing = false;

  isAvailable() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async open() {
    const nav = navigator as Navigator & { serial: Serial };
    this.port = await nav.serial.requestPort();
    await this.port.open({ baudRate: BAUD });
    this.closing = false;
    void this.pump();
  }

  private async pump() {
    if (!this.port?.readable) return;
    const splitter = new LineSplitter((l) => this.cb?.(l));
    const dec = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) splitter.push(dec.decode(value, { stream: true }));
      }
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
  }

  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* já fechado */
    }
    await this.port?.close();
    this.port = null;
  }

  onLine(cb: (line: string) => void) {
    this.cb = cb;
  }

  async write(text: string) {
    if (!this.port?.writable) return;
    const w = this.port.writable.getWriter();
    try {
      await w.write(new TextEncoder().encode(text));
    } finally {
      w.releaseLock();
    }
  }
}

/**
 * Serial USB no Android, pelo plugin nativo deste app.
 *
 * Ver plugins/UsbSerial.ts e o Java correspondente. O caminho foi portado do
 * projeto Android/serial_usb, e a diferença que importa é que o conversor é
 * DESCOBERTO (UsbSerialProber), não adivinhado por lista de VID/PID.
 */
class NativeSerialTransport implements SerialTransport {
  private label = 'USB (Android)';
  get name() {
    return this.label;
  }
  private cb: ((line: string) => void) | null = null;
  private handles: Array<{ remove: () => Promise<void> }> = [];

  isAvailable() {
    return typeof (window as any).Capacitor?.isNativePlatform === 'function'
      ? (window as any).Capacitor.isNativePlatform()
      : false;
  }

  async open() {
    const { UsbSerial } = await import('../plugins/UsbSerial');

    // Diagnóstico antes de tentar: sem isto, "não abriu" não distingue cabo
    // desconectado de conversor sem driver.
    const list = await UsbSerial.listDevices();
    Diag.info(`USB: ${list.usbCount} dispositivo(s), ${list.serialCount} serial`);
    if (list.devices) Diag.info(list.devices);
    if (list.serialCount === 0) {
      throw new Error(
        list.usbCount === 0
          ? 'nada conectado na USB — o cabo OTG está ligado?'
          : 'há dispositivo USB, mas nenhum conversor serial reconhecido',
      );
    }
    Diag.info(`driver: ${list.driver} (${list.vid}:${list.pid})`);

    const perm = await UsbSerial.requestPermission();
    if (!perm.granted) throw new Error('permissão do cabo negada');
    Diag.info('permissao concedida, abrindo…');

    const splitter = new LineSplitter((l) => this.cb?.(l));
    this.handles.push(
      await UsbSerial.addListener('serialData', (ev) => {
        if (ev?.data) splitter.push(ev.data);
      }),
    );
    this.handles.push(
      await UsbSerial.addListener('serialError', (ev) => {
        Diag.error(`leitura: ${ev?.error}`);
      }),
    );

    const r = await UsbSerial.open({ baudRate: BAUD });
    this.label = `USB · ${r.driver ?? 'serial'}`;
    Diag.info(`porta aberta a ${BAUD} baud (${r.driver})`);
  }

  async close() {
    const { UsbSerial } = await import('../plugins/UsbSerial');
    for (const h of this.handles) await h.remove().catch(() => undefined);
    this.handles = [];
    await UsbSerial.close().catch(() => undefined);
  }

  onLine(cb: (line: string) => void) {
    this.cb = cb;
  }

  async write(text: string) {
    const { UsbSerial } = await import('../plugins/UsbSerial');
    await UsbSerial.write({ data: text });
  }
}

/** "$T a=1 b=2" -> { a: '1', b: '2' }; null se a linha não for telemetria. */
export function parseTelemetry(line: string): RadioState | null {
  if (!line.startsWith('$T ')) return null;
  const kv: Record<string, string> = {};
  for (const tok of line.slice(3).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) kv[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  // Número só vale se for número DE VERDADE.
  //
  // Era `Number(kv[k])` cru, e uma linha corrompida na serial — meio quadro
  // colado no seguinte, um byte trocado em `rssi=-9x.0` — virava NaN sem
  // reclamar. O NaN ia para a amostra, dela para o IndexedDB, e o resumo da
  // campanha aparecia como "RSSI NaN a NaN": um Math.max com um NaN dentro
  // devolve NaN e contamina a campanha inteira. Na nuvem virava NULL, ou seja,
  // o ponto chegava lá sem sinal nenhum.
  const num = (k: string) => {
    if (kv[k] === undefined) return undefined;
    const v = Number(kv[k]);
    return Number.isFinite(v) ? v : undefined;
  };

  // A linha precisa estar INTEIRA para virar telemetria. `band` ausente ou
  // vazio é a assinatura de um quadro partido — foi assim que uma campanha
  // ficou gravada com band="" em vez de "433".
  const rawRssi = num('rssi');
  if (rawRssi === undefined) return null;
  if (!kv.band || kv.link === undefined) return null;

  /*
   * rssi >= 0 é AUSÊNCIA de leitura, não uma leitura de zero.
   *
   * O firmware inicializa rssi_/snr_/lq_ em zero e só os sobrescreve quando um
   * quadro chega (range_test.cpp, onFrame). Enquanto não houver enlace, a
   * telemetria sai com `rssi=0.0 snr=0.0 lq=0` — que o app aceitava como
   * medida válida.
   *
   * O estrago é o mesmo do NaN corrigido antes: numa escala negativa, zero é
   * sempre o MAIOR valor, então qualquer campanha que comece sem enlace passava
   * a reportar "melhor RSSI: 0 dBm" para sempre. Aconteceu na Lora1913.
   *
   * O corte é físico, não um chute: um LoRa a 0 dBm na antena significaria o
   * transmissor encostado com potência absurda — a faixa útil vai de -40 a
   * -130 dBm. Nenhum receptor real reporta zero.
   *
   * O quadro segue válido: banda, frequência e potência continuam sendo
   * informação boa. O que não existe é a medida.
   */
  const measured = rawRssi < 0;

  return {
    node: kv.role ?? '',
    band: kv.band ?? '',
    freq: num('freq') ?? 0,
    sf: num('sf') ?? 0,
    bw: num('bw') ?? 0,
    cr: 0,
    power: num('pwr') ?? 0,
    // Os três saem do mesmo onFrame no firmware: sem quadro recebido, nenhum
    // deles é medida. Anular só o RSSI deixaria "SNR 0 dB" na tela, que mente
    // igual.
    rssi: measured ? rawRssi : undefined,
    snr: measured ? num('snr') : undefined,
    lq: measured ? num('lq') : undefined,
    linked: kv.link === '1',
    radioOk: true,
  };
}

export class RadioService {
  private transport: SerialTransport | null = null;
  private latest: RadioState | null = null;
  private listeners: Array<(s: RadioState) => void> = [];

  /** Escolhe o transporte que existir neste ambiente. */
  pickTransport(): SerialTransport {
    const usb = new NativeSerialTransport();
    if (usb.isAvailable()) return usb;
    return new WebSerialTransport();
  }

  isConnected() {
    return this.transport !== null;
  }

  transportName() {
    return this.transport?.name ?? '—';
  }

  async connect(): Promise<void> {
    if (this.transport) return;
    const t = this.pickTransport();
    let first = true;
    t.onLine((line) => {
      const st = parseTelemetry(line);
      if (!st) {
        // Tudo que nao e telemetria vai para o console do app: e a resposta de
        // `stats`, `rssi`, `info` — o que se quer ler quando nao ha monitor
        // serial disponivel. A telemetria fica de fora porque, a 1 Hz, encheria
        // a tela e esconderia justamente essas respostas.
        Diag.info(line.trim());
        return;
      }
      if (first) {
        Diag.info(`telemetria OK — ${st.band} ${st.rssi} dBm`);
        first = false;
      }
      this.latest = st;
      this.listeners.forEach((f) => f(st));
    });
    await t.open();
    this.transport = t;

    // Silencia o log humano da placa.
    //
    // O console do firmware e escrito para gente ler no monitor. Ligado aqui
    // ele vira canal de dados, e a 420000 cada linha de texto custa ~2 ms — o
    // resumo periodico e o log por quadro competiam com a propria telemetria.
    // Em quiet a placa emite so `$T`, e a 1 Hz em vez de 0,2 Hz.
    await t.write('quiet on\n');
    // Uma leitura ja, para a tela nao ficar vazia ate o primeiro periodico.
    await t.write('tel\n');
  }

  async disconnect(): Promise<void> {
    if (!this.transport) return;
    // Devolve o console à placa: quem for plugar o monitor depois espera achar
    // o firmware falando, não mudo.
    await this.transport.write('quiet off\n').catch(() => undefined);
    await this.transport.close();
    this.transport = null;
  }

  onState(cb: (s: RadioState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== cb);
    };
  }

  getLatest(): RadioState | null {
    return this.latest;
  }

  /** Pede uma linha de telemetria agora, sem esperar o periódico de 5 s. */
  async poll(): Promise<void> {
    await this.transport?.write('tel\n');
  }

  /** Manda um comando do console (`pwr 10`, `peer bancada433`, …). */
  async command(cmd: string): Promise<void> {
    await this.transport?.write(`${cmd}\n`);
  }
}

export const radioService = new RadioService();
