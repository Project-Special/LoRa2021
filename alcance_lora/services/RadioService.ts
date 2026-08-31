import { RadioState } from '../types';
import { Diag } from './Diag';
import { CrsfDecoder, setBandaCrsf } from '../lib/crsf';

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
  /** Chamado a cada linha completa recebida (dialeto de texto da bancada). */
  onLine(cb: (line: string) => void): void;
  /**
   * Chamado com os bytes CRUS, sem decodificacao.
   *
   * O receptor ExpressLRS fala CRSF binario. Passar esses bytes por um
   * TextDecoder os destroi -- toda sequencia invalida vira U+FFFD -- e foi
   * exatamente por isso que o app lia o cabo inteiro e continuava dizendo "sem
   * enlace". O caminho de texto continua existindo para a bancada.
   */
  onBytes(cb: (b: Uint8Array) => void): void;
  /**
   * Chamado quando a leitura morre -- cabo removido, host cortado pelo
   * bloqueio de tela. Sem isto o app continuava se achando conectado e o laco
   * de reconexao, que so roda com serialConnected false, nunca disparava.
   */
  onError(cb: (motivo: string) => void): void;
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
  private cbBytes: ((b: Uint8Array) => void) | null = null;
  private cbErro: ((m: string) => void) | null = null;
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
        if (value) {
          this.cbBytes?.(value);
          splitter.push(dec.decode(value, { stream: true }));
        }
      }
    } catch (e) {
      this.cbErro?.(e instanceof Error ? e.message : 'leitura interrompida');
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      if (!this.closing) this.cbErro?.('fluxo encerrado');
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

  onBytes(cb: (b: Uint8Array) => void) {
    this.cbBytes = cb;
  }

  onError(cb: (motivo: string) => void) {
    this.cbErro = cb;
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
  private cbBytes: ((b: Uint8Array) => void) | null = null;
  private cbErro: ((m: string) => void) | null = null;
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
        if (!ev?.data) return;
        // Chega em Base64 porque a ponte Java->JS nao transporta bytes crus e
        // decodificar como UTF-8 destruiria os quadros CRSF do ExpressLRS.
        const bruto = atob(ev.data);
        const bytes = new Uint8Array(bruto.length);
        for (let i = 0; i < bruto.length; i++) bytes[i] = bruto.charCodeAt(i);
        this.cbBytes?.(bytes);
        splitter.push(bruto);
      }),
    );
    this.handles.push(
      await UsbSerial.addListener('serialError', (ev) => {
        Diag.error(`leitura: ${ev?.error}`);
        this.cbErro?.(ev?.error ?? 'leitura interrompida');
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

  onBytes(cb: (b: Uint8Array) => void) {
    this.cbBytes = cb;
  }

  onError(cb: (motivo: string) => void) {
    this.cbErro = cb;
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

/**
 * De onde vem a telemetria.
 *
 * 'usb' e o cabo -- medida direta, sem nada no ar entre o receptor e o
 * celular. 'wifi' fala com o painel do proprio receptor em 192.168.4.1, e
 * existe porque o cabo tem um problema que nao e nosso: o aparelho corta o modo
 * host do USB quando a tela bloqueia (ver manterTelaAtiva).
 *
 * O WiFi tem um custo que o cabo nao tem, e ele precisa estar dito em algum
 * lugar: o AP do receptor transmite em 2,4 GHz, a MESMA banda do enlace
 * ExpressLRS que se esta medindo. Nao e neutro numa campanha de alcance.
 */
export type Fonte = 'usb' | 'wifi';

const URL_PAINEL = 'http://192.168.4.1/api/state';

export class RadioService {
  private transport: SerialTransport | null = null;
  private latest: RadioState | null = null;
  private listeners: Array<(s: RadioState) => void> = [];
  private abertura: Promise<void> | null = null;
  private falhas: Array<(motivo: string) => void> = [];
  private fonte: Fonte = 'usb';
  private enquete: number | null = null;
  private wifiOk = false;

  /** Escolhe o transporte que existir neste ambiente. */
  pickTransport(): SerialTransport {
    const usb = new NativeSerialTransport();
    if (usb.isAvailable()) return usb;
    return new WebSerialTransport();
  }

  getFonte(): Fonte {
    return this.fonte;
  }

  /** Troca a fonte. Se havia conexao, ela e encerrada -- sao caminhos distintos. */
  async setFonte(f: Fonte): Promise<void> {
    if (f === this.fonte) return;
    await this.disconnect().catch(() => undefined);
    this.fonte = f;
  }

  isConnected() {
    return this.transport !== null || this.wifiOk;
  }

  transportName() {
    if (this.fonte === 'wifi') return this.wifiOk ? 'WiFi · 192.168.4.1' : '—';
    return this.transport?.name ?? '—';
  }

  /**
   * Abertura UNICA, mesmo com dois pedidos simultaneos.
   *
   * O guarda era so `if (this.transport) return`, e ele nao servia: transport
   * so e atribuido DEPOIS do await de open(). Duas chamadas concorrentes --
   * a deteccao de USB ocioso e a reconexao -- passavam as duas pelo guarda e
   * abriam a mesma porta duas vezes. O log do celular mostrava o sintoma:
   *
   *     porta aberta a 420000 baud (CdcAcmSerialDriver)
   *     porta aberta a 420000 baud (CdcAcmSerialDriver)
   *     leitura: Queueing USB request failed
   *
   * A segunda abertura reivindica a mesma interface e derruba a leitura da
   * primeira. Era exatamente o "reconhece por algum tempo e para".
   */
  async connect(): Promise<void> {
    if (this.transport) return;
    if (this.abertura) return this.abertura;
    this.abertura = this.abrir();
    try {
      await this.abertura;
    } finally {
      this.abertura = null;
    }
  }

  private async abrir(): Promise<void> {
    if (this.fonte === 'wifi') return this.abrirWifi();
    const t = this.pickTransport();
    let first = true;

    // Duas placas, dois dialetos. A bancada fala texto (`$T ...`); o receptor
    // ExpressLRS fala CRSF binario. O app entende os dois e deixa a PLACA
    // decidir -- assim o mesmo cabo e o mesmo baud servem para as duas, que era
    // o ponto de ter unificado 420000 em todo o projeto.
    let viuCrsf = false;
    const crsf = new CrsfDecoder((l) => {
      if (!viuCrsf) {
        viuCrsf = true;
        Diag.info('receptor ExpressLRS reconhecido (CRSF)');
      }
      const st: RadioState = {
        node: 'ELRS',
        band: l.banda ?? '2g4',
        freq: l.banda === '2g4' ? 2441.4 : 0,
        sf: l.sf ?? 0,
        bw: l.bw ?? 0,
        cr: l.cr ?? 0,
        power: l.power ?? 0,
        rssi: l.rssi,
        snr: l.snr,
        lq: l.lq,
        linked: l.linked,
        radioOk: true,
      };
      if (first && l.linked) {
        Diag.info(`telemetria OK — ELRS ${st.rssi} dBm`);
        first = false;
      }
      this.latest = st;
      this.listeners.forEach((f) => f(st));
    });
    t.onBytes((b) => crsf.push(b));

    // Leitura morta = conexao morta. Derrubar o transporte aqui e o que permite
    // ao laco de reconexao voltar a tentar: ele so roda com a serial marcada
    // como ausente, e antes o app ficava se achando conectado para sempre.
    t.onError((motivo) => {
      if (this.transport !== t) return;
      this.transport = null;
      this.latest = null;
      Diag.warn(`serial caiu: ${motivo}`);
      this.falhas.forEach((f) => f(motivo));
    });

    t.onLine((line) => {
      // Com CRSF confirmado o caminho de texto se cala: os bytes binarios
      // contem 0x0A, e cada um deles viraria uma "linha" de lixo no console.
      if (viuCrsf) return;
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
    //
    // So vale para a bancada. O receptor ExpressLRS nao tem console de texto: a
    // entrada serial dele espera CRSF de um controlador de voo, e despejar
    // comandos ali e injetar lixo num parser que nao os pediu. Por isso espera
    // um instante para ver qual dialeto a placa fala antes de escrever.
    await new Promise((r) => setTimeout(r, 400));
    if (viuCrsf) return;
    await t.write('quiet on\n');
    // Uma leitura ja, para a tela nao ficar vazia ate o primeiro periodico.
    await t.write('tel\n');
  }

  async disconnect(): Promise<void> {
    if (this.enquete !== null) {
      clearInterval(this.enquete);
      this.enquete = null;
    }
    this.wifiOk = false;
    if (!this.transport) return;
    // Devolve o console à placa: quem for plugar o monitor depois espera achar
    // o firmware falando, não mudo.
    // Idem: nao escreve nada num receptor ExpressLRS, que nao tem console.
    if (this.latest?.node !== 'ELRS') {
      await this.transport.write('quiet off\n').catch(() => undefined);
    }
    await this.transport.close();
    this.transport = null;
  }

  /**
   * Telemetria pelo painel do receptor, em vez do cabo.
   *
   * Nao ha protocolo novo: o painel ja publica /api/state no MESMO formato que
   * o app consome do firmware de bancada -- node, band, freq, sf, bw, cr,
   * power, rssi, snr, lq, linked, radioOk. Foi construido assim, e e por isso
   * que este caminho custa uma enquete e um mapeamento, e nao um decodificador.
   *
   * Uma leitura vale como prova de conexao antes de declarar a fonte aberta:
   * associar ao AP nao garante que o painel responda, e um "conectado" que nao
   * traz numero e pior que um erro honesto.
   */
  private async abrirWifi(): Promise<void> {
    const primeira = await this.lerPainel();
    this.aplicar(primeira);
    this.wifiOk = true;
    Diag.info('painel do receptor respondendo em 192.168.4.1');

    let seguidas = 0;
    this.enquete = window.setInterval(async () => {
      try {
        this.aplicar(await this.lerPainel());
        seguidas = 0;
      } catch (e) {
        seguidas++;
        // Uma falha isolada e normal com WiFi; tres seguidas sao uma queda.
        // Derrubar na primeira faria o LED piscar vermelho a toa.
        if (seguidas < 3) return;
        const motivo = e instanceof Error ? e.message : 'painel mudo';
        void this.disconnect().catch(() => undefined);
        Diag.warn(`WiFi caiu: ${motivo}`);
        this.falhas.forEach((f) => f(motivo));
      }
    }, 1000);
  }

  private async lerPainel(): Promise<RadioState> {
    const { UsbSerial } = await import('../plugins/UsbSerial');
    const r = await UsbSerial.espGet({ url: URL_PAINEL });
    if (r.status !== 200) throw new Error(`painel respondeu ${r.status}`);
    return this.doPainel(JSON.parse(r.body));
  }

  /** JSON do painel -> RadioState. Separado porque /api/config devolve o mesmo. */
  private doPainel(j: Record<string, unknown>): RadioState {
    // rssi/snr/lq so existem COM leitura -- o firmware omite os campos quando
    // nao ha. Number.isFinite preserva essa ausencia em vez de virar zero, que
    // numa escala negativa seria sinal maximo.
    const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : undefined);

    // O painel e quem SABE a banda. Guardar aqui faz o caminho do cabo, que
    // nao a carrega no CRSF, acertar a tabela de modem depois.
    if (typeof j.band === 'string') setBandaCrsf(j.band);
    return {
      node: String(j.node ?? 'ELRS'),
      band: String(j.band ?? '2g4'),
      freq: Number(j.freq ?? 0),
      sf: Number(j.sf ?? 0),
      bw: Number(j.bw ?? 0),
      cr: Number(j.cr ?? 0),
      power: Number(j.power ?? 0),
      rssi: num(j.rssi),
      snr: num(j.snr),
      lq: num(j.lq),
      linked: Boolean(j.linked),
      radioOk: j.radioOk !== false,
      rate: num(j.rate),
      rates: Array.isArray(j.rates) ? j.rates : undefined,
      powers: Array.isArray(j.powers) ? j.powers : undefined,
      domain: num(j.domain),
      domains: Array.isArray(j.domains) ? j.domains : undefined,
    };
  }

  /**
   * Troca a taxa -- e, com ela, a BANDA.
   *
   * So existe pelo WiFi: o caminho do cabo e CRSF, que carrega telemetria e nao
   * configuracao. O painel aceita a troca por GET, entao a mesma ponte nativa
   * do espGet serve, sem inventar um POST.
   *
   * A outra ponta precisa da mesma taxa. Nao ha como este lado garantir isso --
   * quem avisa e o texto na tela.
   */
  /** Troca o nivel de potencia. Mesma restricao do setRate: so pelo WiFi. */
  async setPower(i: number): Promise<void> {
    await this.mandarConfig(`pwr=${i}`);
  }

  /**
   * Troca o plano de banda sub-GHz. A placa GRAVA e REINICIA -- por isso nao
   * espera estado de volta: o que responderia ja esta em queda.
   */
  async setDomain(i: number): Promise<void> {
    if (this.fonte !== 'wifi') throw new Error('so pelo WiFi do receptor');
    const { UsbSerial } = await import('../plugins/UsbSerial');
    const alvo = URL_PAINEL.replace('/api/state', '/api/config');
    const r = await UsbSerial.espGet({ url: `${alvo}?domain=${i}` });
    if (r.status !== 200) throw new Error(`painel recusou: ${r.status}`);
    Diag.info('plano de banda gravado; a placa esta reiniciando');
  }

  async setRate(i: number): Promise<void> {
    await this.mandarConfig(`rate=${i}`);
  }

  private async mandarConfig(query: string): Promise<void> {
    if (this.fonte !== 'wifi') throw new Error('so pelo WiFi do receptor');
    const { UsbSerial } = await import('../plugins/UsbSerial');
    const alvo = URL_PAINEL.replace('/api/state', '/api/config');
    const r = await UsbSerial.espGet({ url: `${alvo}?${query}` });
    if (r.status !== 200) throw new Error(`painel recusou: ${r.status}`);
    this.aplicar(this.doPainel(JSON.parse(r.body)));
  }

  private aplicar(s: RadioState) {
    this.latest = s;
    this.listeners.forEach((f) => f(s));
  }

  /** Avisa quando a serial cai sozinha, para quem quiser reconectar. */
  onFailure(cb: (motivo: string) => void): () => void {
    this.falhas.push(cb);
    return () => {
      this.falhas = this.falhas.filter((f) => f !== cb);
    };
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
