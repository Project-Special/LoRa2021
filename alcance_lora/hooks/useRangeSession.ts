import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, RadioState, RangeSample, Session, TxOrigin } from '../types';
import type { Fonte } from '../services/RadioService';
import { radioService } from '../services/RadioService';
import { SessionStore } from '../services/SessionStore';
import { Fix, GeoWatcher, ensurePermission, watch as watchGeo } from '../services/GeoService';
import { CloudSync } from '../services/CloudSync';
import { Diag } from '../services/Diag';
import { Network } from '@capacitor/network';
import { UsbSerial } from '../plugins/UsbSerial';
import { distance3d } from '../lib/geo';

/**
 * Intervalo entre pontos, escolhido pelo usuário.
 *
 * 60 s é o padrão: numa campanha de alcance o que se mede é como o sinal muda
 * ao longo de uma distância grande, e a cada minuto já sai um ponto a cada
 * ~80 m de caminhada — denso o bastante para o mapa e enxuto o bastante para a
 * bateria e para o arquivo. Quem quiser detalhe fino baixa para 1 s.
 */
const DEFAULT_PERIOD_MS = 60000;

/** Não faz sentido pedir mais rápido que a telemetria da placa. */
const MIN_PERIOD_MS = 1000;

/**
 * Amostra pior que isto é descartada.
 *
 * GPS de celular em céu aberto dá 3 a 8 m. Quando a precisão passa de 50 m ele
 * normalmente está usando rede em vez de satélite, e a posição pode errar
 * quarteirões — o que num mapa de alcance inventa cobertura onde não há.
 */
const MAX_ACCURACY_M = 50;

/** O que a nuvem está fazendo. Vira LED na tela, igual ao GPS e à placa. */
export type CloudState = 'off' | 'offline' | 'sending' | 'synced' | 'error';

interface UseRangeSession {
  /** O que está plugado na USB, mesmo com a campanha parada. */
  usbInfo: string;
  usbPresent: boolean;
  cloud: CloudState;
  cloudMessage: string;
  /** Força um envio agora, sem esperar o próximo ciclo. */
  syncNow: () => Promise<void>;
  live: RadioState | null;
  connection: ConnectionState;
  error: string | null;
  samples: RangeSample[];
  origin: TxOrigin | null;
  recording: boolean;
  lastSample: RangeSample | null;
  /** Posição atual do GPS, mesmo antes de virar amostra. */
  fix: Fix | null;
  /** O que o GPS está fazendo enquanto não há fix. Não é erro. */
  gpsStatus: string | null;
  /** Intervalo entre pontos, em ms. */
  periodMs: number;
  setPeriodMs: (ms: number) => void;
  /** Porta serial aberta. Diferente de "chegando telemetria". */
  serialConnected: boolean;
  /** Idade da última telemetria, em ms. Infinity se nunca chegou. */
  telemetryAgeMs: number;
  start: () => Promise<void>;
  stop: () => void;
  clear: () => void;
  setOriginHere: () => void;
  setOriginManual: (lat: number, lon: number, alt: number | null) => void;
  /** Cria o arquivo onde os pontos serão gravados, e o deixa aberto. */
  createFile: (name: string) => Promise<Session>;
  /**
   * Reabre uma campanha para GRAVAR nela, anexando aos pontos que já existem.
   *
   * Diferente de `loadSession`, que é só leitura. Serve para retomar depois de
   * uma pausa — bateria, almoço, o app ter sido fechado — sem partir a
   * campanha em vários arquivos que depois teriam de ser juntados na mão.
   */
  continueFile: (s: Session) => Promise<void>;
  /** Arquivo aberto no momento, ou null. */
  fileId: string | null;
  fileName: string | null;
  loadSession: (s: Session) => void;
  sendCommand: (cmd: string) => Promise<void>;
  transport: string;
  /** Cabo ou WiFi do receptor. */
  fonte: Fonte;
  setFonte: (f: Fonte) => Promise<void>;
  /** Troca a taxa (e a banda). So funciona pelo WiFi. */
  setRate: (i: number) => Promise<void>;
  /** Troca o nivel de potencia. So funciona pelo WiFi. */
  setPower: (i: number) => Promise<void>;
  /** Troca o plano de banda sub-GHz. Reinicia a placa. */
  setDomain: (i: number) => Promise<void>;
}

export function useRangeSession(): UseRangeSession {
  const [live, setLive] = useState<RadioState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<RangeSample[]>([]);
  const [origin, setOrigin] = useState<TxOrigin | null>(null);
  const [recording, setRecording] = useState(false);
  const [transport, setTransport] = useState('—');
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);
  const [periodMs, setPeriodMsState] = useState(DEFAULT_PERIOD_MS);
  // O intervalo é lido dentro do timer, que não se reinscreve a cada mudança;
  // por isso vive num ref além do state.
  const periodRef = useRef(DEFAULT_PERIOD_MS);
  const [serialConnected, setSerialConnected] = useState(false);
  // Instante da última telemetria. A idade é derivada disso a cada volta do
  // intervalo: porta aberta e placa muda são estados diferentes, e só a idade
  // separa os dois.
  const [lastTelemetryAt, setLastTelemetryAt] = useState(0);
  // Hardware VISTO, e não hardware LIDO.
  //
  // O app só abre a porta serial quando a campanha começa. Antes disso ele não
  // fazia ideia de que a placa estava ali — e a barra de status dizia "parado"
  // com o cabo no lugar e o enlace vivo do outro lado. Tecnicamente correto e
  // inútil: quem olha quer saber se pode começar, e "parado" não responde isso.
  //
  // listDevices() enumera SEM abrir a porta, então dá para responder essa
  // pergunta sem disputar o cabo com nada.
  const [usbInfo, setUsbInfo] = useState('procurando cabo…');
  const [usbPresent, setUsbPresent] = useState(false);

  const [cloud, setCloud] = useState<CloudState>(
    CloudSync.isConfigured() ? 'offline' : 'off',
  );
  const [cloudMessage, setCloudMessage] = useState<string>(
    CloudSync.isConfigured() ? 'aguardando rede' : 'nuvem não configurada',
  );
  // Um envio de cada vez. Sem isto, um ciclo lento numa rede ruim seria
  // alcançado pelo seguinte e as duas execuções mandariam os mesmos pontos.
  const syncingRef = useRef(false);

  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<string | null>(null);

  // Fila de pontos ainda não gravados.
  //
  // Gravar a cada ponto faria uma transação IndexedDB por segundo, e cada uma
  // regrava a campanha inteira. Acumular alguns segundos e descarregar em bloco
  // custa, no pior caso, perder o último punhado de pontos — e o que não se
  // pode perder é a caminhada inteira, que era o risco do fluxo antigo.
  const pendingRef = useRef<RangeSample[]>([]);

  // O GPS é assíncrono e o polling do rádio também. Guardar a última posição
  // num ref evita que o intervalo dependa dela e se reinscreva a cada fix.
  const posRef = useRef<Fix | null>(null);
  // Timestamp do último fix usado. Não bloqueia nada — serve só para anunciar
  // há quanto tempo a posição está repetindo.
  const lastFixTRef = useRef(0);
  const nextSampleAtRef = useRef(0);
  const originRef = useRef<TxOrigin | null>(null);
  const watchRef = useRef<GeoWatcher | null>(null);
  const timerRef = useRef<number | null>(null);
  const flushRef = useRef<number | null>(null);

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  // Telemetria empurrada pela serial, e não só a lida na hora de amostrar.
  //
  // O LED precisa dizer a verdade a cada segundo. Antes `live` só era atualizado
  // dentro do timer de amostragem — com intervalo de 60 s, o LED ficava um
  // minuto inteiro mostrando um enlace que já tinha caído.
  useEffect(
    () =>
      radioService.onState((s) => {
        setLive(s);
        setLastTelemetryAt(Date.now());
      }),
    [],
  );

  // Relógio de 1 Hz enquanto grava.
  //
  // A idade da telemetria é derivada no render; sem alguém forçando o render,
  // "placa muda" nunca apareceria — justamente o caso em que nada mais chega
  // para provocar atualização.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  /**
   * Grava um ponto. SEMPRE que o intervalo vence, haja posição nova ou não.
   *
   * Já foi o contrário: um fix repetido era recusado, para não gravar um ponto
   * afirmando uma posição sem evidência nova. A intenção era honestidade, o
   * efeito foi dúvida — a contagem parava de subir e não havia como distinguir
   * "o GPS não se moveu" de "o app travou". Num teste de campo essa dúvida
   * custa mais que o dado repetido, porque leva a refazer a caminhada.
   *
   * Então grava sempre, e quem avisa que a posição está repetindo é o status do
   * GPS, à vista na barra. O problema de verdade — o Android estrangulando a
   * localização em segundo plano — foi resolvido no lugar certo, com o serviço
   * em primeiro plano do GeoService.
   */
  const maybeSample = useCallback(async (pos: Fix) => {
    const now = Date.now();
    if (now < nextSampleAtRef.current) return;

    // Posição repetida NÃO impede a gravação — só é anunciada. É a diferença
    // entre o operador ver "o GPS está travado" e ver a contagem congelada sem
    // explicação nenhuma.
    if (pos.t !== 0 && pos.t === lastFixTRef.current) {
      const age = Math.round((now - pos.t) / 1000);
      setGpsStatus(`sem posição nova há ${age} s — gravando no mesmo ponto`);
    }

    const acc = pos.accuracy;
    if (acc != null && acc > MAX_ACCURACY_M) {
      setGpsStatus(`±${Math.round(acc)} m — impreciso demais, ponto descartado`);
      return;
    }

    nextSampleAtRef.current = now + periodRef.current;
    lastFixTRef.current = pos.t;

    // A telemetria chega sozinha pela serial; o `poll` pede uma na hora de
    // amostrar, para o ponto levar o valor do instante e não o do último
    // periódico.
    await radioService.poll().catch(() => undefined);
    const state = radioService.getLatest();
    if (state) {
      setLive(state);
      setLastTelemetryAt(Date.now());
      setConnection('online');
    } else {
      setConnection('error');
    }

    const alt = pos.altitude;
    const o = originRef.current;
    const sample: RangeSample = {
      // O instante da MEDIDA, não o do fix.
      //
      // Datar pelo fix parecia mais preciso e quebrava duas coisas: o RSSI é
      // lido agora, não quando o GPS falou; e com a posição repetida dois
      // pontos ficariam com o mesmo `t` — o envio incremental corta por
      // `t > último enviado`, então o segundo nunca subiria para a nuvem.
      t: now,
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitude: alt,
      accuracy: acc,
      rssi: state?.rssi ?? null,
      snr: state?.snr ?? null,
      lq: state?.lq ?? null,
      linked: !!state?.linked,
      distance: o
        ? distance3d(o.latitude, o.longitude, o.altitude, pos.latitude, pos.longitude, alt)
        : null,
    };

    setSamples((prev) => [...prev, sample]);

    const id = fileRef.current;
    if (!id) return;
    pendingRef.current.push(sample);

    // Grava JÁ, quando o intervalo é folgado.
    //
    // A fila de 5 s existia para não fazer uma transação IndexedDB por segundo.
    // Mas o timer que a esvaziava é estrangulado com a tela apagada — que é
    // exatamente quando a campanha está acontecendo —, e a fila podia ficar
    // parada por minutos com pontos só na memória. Com intervalo de 5 s ou
    // mais, uma escrita por ponto não custa nada e o ponto está salvo assim que
    // existe.
    if (periodRef.current >= 5000) {
      const batch = pendingRef.current;
      pendingRef.current = [];
      await SessionStore.append(id, batch).catch((e) =>
        Diag.error(`falha ao gravar ponto: ${e instanceof Error ? e.message : e}`),
      );
    }
  }, []);

  const stop = useCallback(() => {
    setRecording(false);
    void radioService.disconnect();
    setSerialConnected(false);
    // Sem isto, reabrir a campanha herdaria a idade da telemetria anterior e o
    // LED nasceria verde antes da primeira linha nova chegar.
    setLastTelemetryAt(0);
    setLive(null);
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (flushRef.current != null) {
      clearInterval(flushRef.current);
      flushRef.current = null;
    }
    // Grava o que sobrou antes de sair, senão os últimos segundos somem.
    const id = fileRef.current;
    const rest = pendingRef.current;
    if (id && rest.length) {
      pendingRef.current = [];
      void SessionStore.append(id, rest);
    }
    if (watchRef.current) {
      watchRef.current.stop();
      watchRef.current = null;
    }
    setConnection('idle');
  }, []);

  const start = useCallback(async () => {
    if (timerRef.current != null) return;
    setError(null);
    setConnection('connecting');
    setRecording(true);
    // Campanha nova começa com o relógio zerado: o primeiro ponto sai assim que
    // houver posição, sem esperar um intervalo inteiro.
    lastFixTRef.current = 0;
    nextSampleAtRef.current = 0;

    // GPS PRIMEIRO, e independente do rádio.
    //
    // Antes a serial vinha antes e um `return` no catch dela abortava tudo — o
    // pedido de permissão de localização nem chegava a acontecer, e o Android
    // ficava com ACCESS_FINE_LOCATION negado sem nunca ter mostrado o diálogo.
    // São duas fontes independentes: cabo com problema não pode custar o
    // trajeto, e GPS sem sinal não pode custar a leitura do rádio.
    const permErr = await ensurePermission();
    if (permErr) {
      setError(permErr);
    } else {
      watchRef.current = await watchGeo(
        (f) => {
          posRef.current = f;
          setFix(f);
          setGpsStatus(null);
          // O FIX é que dispara a amostra, não o relógio. Ver maybeSample.
          void maybeSample(f);
        },
        (msg) => setError(msg),
        (msg) => setGpsStatus(msg),
      );
    }

    try {
      await radioService.connect();
      setTransport(radioService.transportName());
      setSerialConnected(true);
    } catch (e) {
      // Avisa, mas segue: o trajeto continua sendo gravado, com RSSI vazio.
      setConnection('error');
      setSerialConnected(false);
      const onde = radioService.getFonte() === 'wifi' ? 'WiFi' : 'Serial';
      setError(`${onde}: ${e instanceof Error ? e.message : 'falha ao abrir'}`);
    }

    // O timer vira REDE DE SEGURANÇA, não a fonte.
    //
    // Ele continua batendo a cada segundo para o caso de o GPS entregar fixes
    // mais rápido que o intervalo pedido — aí a amostra sai na hora certa em
    // vez de esperar o fix seguinte. Mas ele não consegue mais inventar ponto:
    // maybeSample recusa um fix que já virou amostra.
    timerRef.current = window.setInterval(() => {
      const pos = posRef.current;
      if (pos) void maybeSample(pos);
    }, 1000);

    // Descarrega a fila no arquivo a cada 5 s.
    flushRef.current = window.setInterval(() => {
      const id = fileRef.current;
      const batch = pendingRef.current;
      if (!id || !batch.length) return;
      pendingRef.current = [];
      void SessionStore.append(id, batch);
    }, 5000);
  }, []);

  useEffect(() => stop, [stop]);

  /**
   * Sobe para a nuvem tudo que ainda não está lá.
   *
   * A gravação primária continua sendo o IndexedDB — um teste de alcance
   * acontece longe de cobertura, e falhar aqui não pode custar a coleta. Isto é
   * o segundo destino, e ele existe porque depender do usuário lembrar de
   * apertar "enviar" já custou caro: uma campanha subiu com 1 ponto de 31, e o
   * envio antigo respondia "Já estava na nuvem" para sempre depois disso.
   */
  const syncNow = useCallback(async () => {
    if (!CloudSync.isConfigured() || syncingRef.current) return;

    const status = await Network.getStatus().catch(() => null);
    if (!status?.connected) {
      setCloud('offline');
      setCloudMessage('sem rede — os pontos ficam no aparelho');
      return;
    }

    syncingRef.current = true;
    setCloud('sending');
    try {
      const r = await CloudSync.syncAll();
      setCloud(r.ok ? 'synced' : 'error');
      setCloudMessage(r.message);
      // O resultado TEM de aparecer em algum lugar.
      //
      // Sem isto o envio automático é uma caixa preta: roda sozinho, e quando
      // não sobe nada não há como saber se foi "não havia o que enviar" ou
      // "falhou e ninguém viu". Só o que muda de estado vira linha, senão o
      // registro enche de "tudo já estava na nuvem" a cada ciclo.
      if (!r.ok) Diag.error(`nuvem: ${r.message}`);
      else if (r.sent) Diag.info(`nuvem: ${r.message}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'falha no envio';
      setCloud('error');
      setCloudMessage(msg);
      Diag.error(`nuvem: ${msg}`);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  // Envio automático, no ritmo do app.
  //
  // A cadência acompanha o intervalo entre pontos — não adianta enviar mais
  // rápido do que nasce ponto novo — com piso de 15 s: com o intervalo em 1 s,
  // um POST por segundo gastaria bateria e dados para subir uma linha de cada
  // vez. O relógio de 1 s aqui é só o que permite mudar o intervalo e a
  // cadência acompanhar sem reinscrever nada.
  useEffect(() => {
    if (!CloudSync.isConfigured()) return;

    let next = 0;
    const tick = () => {
      const now = Date.now();
      if (now < next) return;
      next = now + Math.max(15000, periodRef.current);
      void syncNow();
    };

    // Uma passada logo ao abrir o app: é ela que recupera campanhas que ficaram
    // pela metade na nuvem em sessões anteriores.
    tick();
    const id = window.setInterval(tick, 1000);

    // A volta da rede não espera o próximo ciclo: sair do túnel e já sincronizar
    // é o comportamento que o operador espera ver.
    const handle = Network.addListener('networkStatusChange', (st) => {
      if (st.connected) {
        next = 0;
        tick();
      } else {
        setCloud('offline');
        setCloudMessage('sem rede — os pontos ficam no aparelho');
      }
    });

    return () => {
      clearInterval(id);
      void handle.then((h) => h.remove());
    };
  }, [syncNow]);

  // Enquanto NÃO grava, varre a USB. Durante a gravação a porta já está aberta
  // e quem responde pelo estado é a telemetria — perguntar de novo só criaria
  // uma segunda verdade sobre a mesma coisa.
  useEffect(() => {
    // Continua varrendo TAMBÉM durante a gravação enquanto a porta não abriu:
    // é exatamente aí que o operador está plugando o cabo e quer ver o app
    // reagir.
    if (recording && serialConnected) return;
    let alive = true;

    const look = async () => {
      try {
        const r = await UsbSerial.listDevices();
        if (!alive) return;
        setUsbPresent(r.serialCount > 0);
        if (r.serialCount > 0) {
          setUsbInfo(`placa detectada${r.driver ? ` (${r.vid}:${r.pid})` : ''} — inicie para ler`);
        } else if (r.usbCount > 0) {
          // Há USB e nenhum serial: é cabo ou adaptador errado, não ausência de
          // placa. As duas coisas pedem ações opostas.
          setUsbInfo(`${r.usbCount} dispositivo(s) USB, nenhum serial`);
        } else {
          setUsbInfo('sem cabo');
        }
      } catch {
        // Navegador de mesa, ou plugin ausente: não é erro, é outro ambiente.
        if (alive) {
          setUsbPresent(false);
          setUsbInfo('parado');
        }
      }
    };

    void look();
    const id = window.setInterval(look, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [recording, serialConnected]);

  /**
   * Reata a serial enquanto a campanha roda.
   *
   * Antes ela era tentada UMA vez, no start. Falhou, falhou para sempre: o
   * operador plugava o cabo e o app não reagia até parar e recomeçar a
   * campanha — e nada na tela dizia que era isso. Aconteceu de verdade ao tirar
   * o celular do PC: o Android ainda estava saindo do modo dispositivo, a USB
   * apareceu vazia, e a campanha seguiu meia hora sem RSSI.
   *
   * O GPS já reatava sozinho a cada 3 s. Não havia motivo para a serial ser
   * tratada como falha definitiva, e sim para ser tratada igual.
   */
  // De onde vem a telemetria. Nao ha deteccao automatica de proposito: as duas
  // fontes falam com a MESMA placa, e adivinhar qual o operador quis ficaria
  // trocando de caminho sozinho no meio de uma campanha.
  const [fonte, setFonteEstado] = useState<Fonte>(radioService.getFonte());

  const setRate = useCallback(async (i: number) => {
    try {
      await radioService.setRate(i);
    } catch (e) {
      setError(`Taxa: ${e instanceof Error ? e.message : 'falha'}`);
    }
  }, []);

  const setDomain = useCallback(async (i: number) => {
    try {
      await radioService.setDomain(i);
    } catch (e) {
      setError(`Plano: ${e instanceof Error ? e.message : 'falha'}`);
    }
  }, []);

  const setPower = useCallback(async (i: number) => {
    try {
      await radioService.setPower(i);
    } catch (e) {
      setError(`Potencia: ${e instanceof Error ? e.message : 'falha'}`);
    }
  }, []);

  const setFonte = useCallback(async (f: Fonte) => {
    await radioService.setFonte(f);
    setFonteEstado(f);
    setSerialConnected(false);
    setTransport(radioService.transportName());
    setLive(null);
    Diag.info(f === 'wifi' ? 'fonte: WiFi do receptor' : 'fonte: cabo USB');
  }, []);

  // Tela acesa enquanto grava.
  //
  // Nao e conforto de leitura: em aparelhos Samsung o bloqueio de tela dispara
  // o UsbHostRestrictor, que CORTA o modo host do USB. A serial morre com a
  // placa ligada e o cabo no lugar -- foi o que os logs do aparelho mostraram,
  // `enterRestriction: Screen Lock On` seguido de `USB HOST UEVENT STATE=REMOVE`
  // e da falha de leitura. Numa campanha de alcance isso e perder a medida no
  // meio do caminho.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const { UsbSerial } = await import('../plugins/UsbSerial');
        if (vivo) await UsbSerial.manterTelaAtiva({ on: recording });
      } catch {
        // Navegador, ou plugin ausente: segue sem segurar a tela.
      }
    })();
    return () => {
      vivo = false;
    };
  }, [recording]);

  // A serial pode cair sozinha -- cabo removido, ou o host USB cortado pelo
  // bloqueio de tela do aparelho. Sem escutar isso o app seguia se achando
  // conectado, e o laco de reconexao abaixo (que so roda com a serial ausente)
  // nunca disparava: ficava morto ate alguem reiniciar a campanha.
  useEffect(() => {
    return radioService.onFailure(() => {
      setSerialConnected(false);
      setLive(null);
    });
  }, []);

  useEffect(() => {
    if (!recording || serialConnected) return;
    let alive = true;
    let busy = false;

    const tryConnect = async () => {
      if (!alive || busy) return;
      busy = true;
      try {
        await radioService.connect();
        if (!alive) return;
        setTransport(radioService.transportName());
        setSerialConnected(true);
        // Some com o aviso antigo: deixá-lo na tela depois de conectar faria o
        // operador desconfiar de um problema que já passou.
        setError(null);
        Diag.info('serial conectada');
      } catch {
        // Segue tentando, calado. A fita da placa já diz o que está vendo, e
        // um erro por tentativa encheria o registro a cada 5 s.
      } finally {
        busy = false;
      }
    };

    const id = window.setInterval(tryConnect, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [recording, serialConnected]);

  const clear = useCallback(() => {
    setSamples([]);
    setOrigin(null);
  }, []);

  const setOriginHere = useCallback(() => {
    const pos = posRef.current;
    if (!pos) {
      setError('Sem posição do GPS ainda — aguarde o primeiro fix.');
      return;
    }
    setOrigin({
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitude: pos.altitude,
      source: 'gps',
    });
  }, []);

  const setOriginManual = useCallback((lat: number, lon: number, alt: number | null) => {
    setOrigin({ latitude: lat, longitude: lon, altitude: alt, source: 'manual' });
  }, []);

  const createFile = useCallback(
    async (name: string): Promise<Session> => {
      const session = await SessionStore.create({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim() || `Campanha ${new Date().toLocaleString('pt-BR')}`,
        createdAt: Date.now(),
        band: live?.band ?? null,
        freqMHz: live?.freq ?? null,
        powerDbm: live?.power ?? null,
        origin,
      });
      fileRef.current = session.id;
      setFileId(session.id);
      setFileName(session.name);
      setSamples([]);
      pendingRef.current = [];
      return session;
    },
    [live, origin],
  );

  // A banda e a origem podem ser definidas depois de criar o arquivo; o
  // cabeçalho da campanha acompanha em vez de ficar congelado no instante zero.
  useEffect(() => {
    if (!fileId) return;
    void SessionStore.patch(fileId, {
      band: live?.band ?? null,
      freqMHz: live?.freq ?? null,
      powerDbm: live?.power ?? null,
      origin,
    });
  }, [fileId, live?.band, live?.freq, live?.power, origin]);

  const loadSession = useCallback(
    (s: Session) => {
      stop();
      setSamples(s.samples);
      setOrigin(s.origin);
      setLive(null);
      setTransport(radioService.transportName());
      // Abrir uma campanha salva é só leitura: não continua gravando nela.
      fileRef.current = null;
      setFileId(null);
      setFileName(s.name);
    },
    [stop],
  );

  const continueFile = useCallback(
    async (session: Session) => {
      stop();
      setSamples(session.samples);
      setOrigin(session.origin);
      // A origem vem do arquivo, não do lugar onde se está agora: continuar uma
      // campanha noutro ponto não pode mover o transmissor.
      originRef.current = session.origin;
      fileRef.current = session.id;
      setFileId(session.id);
      setFileName(session.name);
      pendingRef.current = [];
      await start();
    },
    [start, stop],
  );

  const setPeriodMs = useCallback((ms: number) => {
    const v = Math.max(MIN_PERIOD_MS, Math.round(ms));
    periodRef.current = v;
    setPeriodMsState(v);
  }, []);

  const sendCommand = useCallback(async (cmd: string) => {
    await radioService.command(cmd);
  }, []);

  return {
    usbInfo,
    usbPresent,
    cloud,
    cloudMessage,
    syncNow,
    live,
    connection,
    error,
    gpsStatus,
    periodMs,
    setPeriodMs,
    samples,
    origin,
    recording,
    lastSample: samples.length ? samples[samples.length - 1] : null,
    fix,
    start,
    stop,
    clear,
    setOriginHere,
    setOriginManual,
    createFile,
    continueFile,
    fileId,
    fileName,
    loadSession,
    sendCommand,
    transport,
    serialConnected,
    fonte,
    setFonte,
    setRate,
    setPower,
    setDomain,
    telemetryAgeMs: lastTelemetryAt ? Date.now() - lastTelemetryAt : Infinity,
  };
}
