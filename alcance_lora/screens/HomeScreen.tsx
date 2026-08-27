import React, { useEffect, useState } from 'react';
import { ConnectionState, RadioState, RangeSample, Session, SessionSummary, TxOrigin } from '../types';
import { Fix } from '../services/GeoService';
import { StatusBar } from '../components/StatusBar';
import { ConsolePanel } from '../components/ConsolePanel';
import { SessionStore } from '../services/SessionStore';
import { CloudSync, CloudSummary } from '../services/CloudSync';
import { formatDistance, rssiColor, rssiFraction } from '../lib/geo';
import { Digit, Gauge } from '../components/Gauge';
import { LinkLed } from '../components/LinkLed';
import { exportText } from '../lib/exportFile';
import { CloudState } from '../hooks/useRangeSession';

type Mode = 'menu' | 'live' | 'open';

interface Props {
  live: RadioState | null;
  connection: ConnectionState;
  error: string | null;
  samples: RangeSample[];
  origin: TxOrigin | null;
  recording: boolean;
  lastSample: RangeSample | null;
  fix: Fix | null;
  gpsStatus: string | null;
  periodMs: number;
  onSetPeriodMs: (ms: number) => void;
  serialConnected: boolean;
  telemetryAgeMs: number;
  transport: string;
  cloud: CloudState;
  cloudMessage: string;
  onSyncNow: () => Promise<void>;
  usbInfo: string;
  usbPresent: boolean;
  onStart: () => Promise<void>;
  onStop: () => void;
  onClear: () => void;
  onSetOriginHere: () => void;
  onSendCommand: (cmd: string) => Promise<void>;
  createFile: (name: string) => Promise<Session>;
  continueFile: (s: Session) => Promise<void>;
  fileId: string | null;
  fileName: string | null;
  onLoadSession: (s: Session) => void;
  onOpenMap: () => void;
  onOpenDatabase: () => void;
}

export const HomeScreen: React.FC<Props> = (p) => {
  const [mode, setMode] = useState<Mode>('menu');
  const [saved, setSaved] = useState<SessionSummary[]>([]);
  // De onde a lista de campanhas vem. O aparelho é o padrão: é o que existe
  // offline, e uma campanha acontece longe de rede.
  const [source, setSource] = useState<'device' | 'cloud'>('device');
  const [remote, setRemote] = useState<CloudSummary[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => SessionStore.list().then(setSaved).catch(() => setSaved([]));

  const refreshRemote = async () => {
    setBusy('Lendo a nuvem…');
    const list = await CloudSync.listRemote();
    setRemote(list);
    setBusy(list.length ? null : 'Nenhuma campanha na nuvem (ou sem rede).');
  };

  /**
   * Apaga a campanha da NUVEM. A cópia do aparelho, se houver, fica.
   *
   * A confirmação nomeia a campanha e diz quantos pontos vão embora, e avisa
   * quando aquela é a última cópia. "Só na nuvem" e "também no aparelho" são
   * situações muito diferentes: numa dá para reenviar, na outra o dado acaba.
   */
  const removeRemote = async (item: CloudSummary) => {
    const local = saved.find((x) => x.id === item.localId);
    const aviso = local
      ? 'A cópia no aparelho continua, e o envio automático vai recriá-la na nuvem.'
      : 'Esta é a ÚLTIMA cópia — não existe no aparelho. Não há como desfazer.';

    if (!window.confirm(`Apagar "${item.name}" da nuvem?\n\n${item.samples} pontos.\n${aviso}`)) {
      return;
    }

    setBusy(`Apagando "${item.name}"…`);
    const r = await CloudSync.deleteRemote(item.id);
    setBusy(r.message);
    // Falha de ação destrutiva interrompe. O aviso de topo fica longe do botão
    // numa lista rolada, e não ser lido faz o operador achar que apagou.
    if (!r.ok) {
      window.alert(r.message);
      return;
    }
    setRemote((prev) => prev.filter((x) => x.id !== item.id));
  };

  /** Baixa do banco e joga direto no mapa. Só leitura: não grava por cima. */
  const openRemote = async (item: CloudSummary) => {
    setBusy(`Baixando "${item.name}" (${item.samples} pontos)…`);
    const full = await CloudSync.download(item.id);
    if (!full) {
      setBusy('Falha ao baixar a campanha.');
      return;
    }
    setBusy(null);
    p.onLoadSession(full);
    p.onOpenMap();
  };
  useEffect(() => {
    refresh();
  }, []);

  const handleCreate = async () => {
    setMode('live');
    try {
      const s = await p.createFile(name);
      setName('');
      setBusy(`Arquivo criado: ${s.name}. Os pontos vao sendo gravados nele.`);
      await p.onStart();
      refresh();
    } catch (e) {
      setBusy(`Falha ao criar: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleUpload = async () => {
    // Manda TUDO, não só a campanha aberta: o botão existe para quem quer a
    // garantia agora, e deixar de fora as outras campanhas era como o buraco
    // aparecia — a aberta subia e as antigas ficavam pela metade em silêncio.
    setBusy('Enviando…');
    await p.onSyncNow();
    setBusy(null);
  };

  const handleOpen = async (id: string) => {
    try {
      const s = await SessionStore.get(id);
      if (!s) {
        setBusy('Campanha nao encontrada no aparelho.');
        return;
      }
      p.onLoadSession(s);
      p.onOpenMap();
    } catch (e) {
      setBusy(`Falha ao abrir: ${e instanceof Error ? e.message : e}`);
    }
  };

  const download = async (id: string, kind: 'geojson' | 'csv') => {
    const s = await SessionStore.get(id);
    if (!s) {
      setBusy('Campanha nao encontrada no aparelho.');
      return;
    }
    const body = kind === 'csv' ? SessionStore.toCSV(s) : SessionStore.toGeoJSON(s);
    const name = `${s.name.replace(/[^\w-]+/g, '_')}.${kind === 'csv' ? 'csv' : 'geojson'}`;
    setBusy(`Preparando ${name}…`);
    // O resultado vai para a tela SEMPRE. O botão antigo não dizia nada quando
    // o WebView engolia o download, e o usuário não tinha como saber se o
    // arquivo tinha saído ou não.
    const r = await exportText(name, kind === 'csv' ? 'text/csv' : 'application/geo+json', body);
    setBusy(r.message);
  };

  return (
    <div className="p-4 max-w-xl mx-auto space-y-4">
      {/* O LED fica no cabeçalho, que é comum aos três modos — menu, ao vivo e
          abrir —, então nenhuma tela do app fica sem o estado da comunicação. */}
      {/* `top` recortado pela barra de status, e não 0.
          O sticky cola no topo do VIEWPORT, que fica por baixo do relógio e da
          bateria do Android — o padding do <body> não o afeta, porque sticky
          não enxerga o padding do ancestral. O título ficava ilegível em cima
          dos ícones do sistema. */}
      <header
        className="sticky z-30 -mx-4 px-4 py-2 bg-background-dark/90 backdrop-blur flex items-center justify-between gap-2"
        style={{ top: 'env(safe-area-inset-top)' }}
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Alcance LoRa</h1>
          <p className="text-xs text-slate-400 truncate">
            {p.live ? `${p.live.band} · ${p.live.freq} MHz · ${p.live.power} dBm` : 'rádio não lido'}
          </p>
        </div>
        <LinkLed
          recording={p.recording}
          serialConnected={p.serialConnected}
          live={p.live}
          telemetryAgeMs={p.telemetryAgeMs}
          idleDetail={p.usbInfo}
        />
      </header>

      <StatusBar
        fix={p.fix}
        gpsStatus={p.gpsStatus}
        live={p.live}
        serialConnected={p.serialConnected}
        transport={p.transport}
        telemetryAgeMs={p.telemetryAgeMs}
        recording={p.recording}
        cloud={p.cloud}
        cloudMessage={p.cloudMessage}
        usbInfo={p.usbInfo}
        usbPresent={p.usbPresent}
      />

      {p.error && (
        <div className="rounded-lg bg-danger/15 border border-danger/40 text-danger text-sm p-3">{p.error}</div>
      )}
      {busy && <div className="rounded-lg bg-primary/15 border border-primary/40 text-sm p-3">{busy}</div>}

      {mode === 'menu' && (
        <div className="grid gap-3">
          <button
            onClick={() => {
              setMode('live');
              void p.onStart();
            }}
            className="rounded-2xl bg-primary hover:bg-primary-dark text-white p-5 text-left transition"
          >
            <div className="text-lg font-bold">Tempo real</div>
            <div className="text-sm opacity-80">Ler o rádio e o GPS agora, marcando o trajeto</div>
          </button>

          <div className="rounded-2xl bg-white/5 border border-white/10 p-5 space-y-2">
            <div className="flex items-baseline justify-between">
              <div className="text-lg font-bold">Intervalo entre pontos</div>
              <div className="text-xl font-bold tabular-nums text-primary">
                {p.periodMs >= 60000
                  ? `${Math.round(p.periodMs / 60000)} min`
                  : `${Math.round(p.periodMs / 1000)} s`}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[1, 5, 15, 30, 60, 120, 300, 600].map((sec) => (
                <button
                  key={sec}
                  onClick={() => p.onSetPeriodMs(sec * 1000)}
                  className={`rounded-lg py-2 text-xs font-semibold ${
                    p.periodMs === sec * 1000
                      ? 'bg-primary text-white'
                      : 'bg-white/10 text-slate-300'
                  }`}
                >
                  {sec < 60 ? `${sec}s` : `${sec / 60}min`}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400">
              A cada {Math.round(p.periodMs / 1000)} s um ponto é gravado. Caminhando a
              5 km/h isso dá um ponto a cada{' '}
              <b>{Math.round((p.periodMs / 1000) * 1.39)} m</b>; de carro a 60 km/h,{' '}
              <b>{Math.round((p.periodMs / 1000) * 16.7)} m</b>.
            </p>
          </div>

          <div className="rounded-2xl bg-white/5 border border-white/10 p-5 space-y-2">
            <div className="text-lg font-bold">Criar arquivo</div>
            <div className="text-sm text-slate-400">
              Onde os pontos serão gravados. Cada amostra vai direto pro arquivo,
              então fechar o app não perde a caminhada.
            </div>
            <div className="flex gap-2 pt-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nome da campanha"
                className="flex-1 rounded-lg bg-black/30 border border-white/10 p-2 text-sm text-white"
              />
              <button onClick={handleCreate} className="rounded-lg bg-success/80 px-4 text-sm font-semibold">
                Criar
              </button>
            </div>
          </div>

          {CloudSync.isConfigured() && (
            <button
              onClick={p.onOpenDatabase}
              className="rounded-2xl bg-white/5 border border-white/10 p-5 text-left hover:bg-white/10 transition"
            >
              <div className="text-lg font-bold">Banco de dados</div>
              <div className="text-sm text-slate-400">
                Tabela e mapa lado a lado, de qualquer aparelho
              </div>
            </button>
          )}

          <button
            onClick={() => {
              setMode('open');
              refresh();
              if (CloudSync.isConfigured()) void refreshRemote();
            }}
            className="rounded-2xl bg-white/5 border border-white/10 p-5 text-left hover:bg-white/10 transition"
          >
            <div className="text-lg font-bold">Abrir</div>
            <div className="text-sm text-slate-400">
              {saved.length} no aparelho
              {CloudSync.isConfigured() && ` · ${remote.length} na nuvem`}
            </div>
          </button>

          {p.samples.length > 0 && (
            <button onClick={p.onOpenMap} className="rounded-xl border border-white/10 p-3 text-sm hover:bg-white/5">
              Ver no mapa
            </button>
          )}

          <ConsolePanel onCommand={p.onSendCommand} connected={p.serialConnected} />
        </div>
      )}

      {mode === 'live' && (
        <div className="space-y-4">
          {/* Mostradores grandes para as duas grandezas que decidem a
              campanha; o resto vira linha de leitura. Ver components/Gauge. */}
          <div className="grid gap-2">
            <Gauge
              label="Sinal"
              value={p.live?.rssi ?? null}
              unit="dBm"
              fill={rssiFraction(p.live?.rssi ?? null)}
              color={rssiColor(p.live?.rssi ?? null)}
              hint={p.live?.linked ? undefined : 'sem enlace — nenhum quadro chegando'}
            />
            <Gauge
              label="Qualidade de enlace"
              value={p.live?.lq ?? null}
              unit="%"
              fill={(p.live?.lq ?? 0) / 100}
              // LQ é percentual: a própria cor do valor conta a história, do
              // vermelho ao verde, sem precisar decorar faixa nenhuma.
              color={`hsl(${Math.round(((p.live?.lq ?? 0) / 100) * 120)}, 85%, 45%)`}
            />
          </div>

          <div className="rounded-xl bg-white/5 border border-white/10 p-4 grid gap-3">
            <Digit label="SNR" value={p.live?.snr != null ? String(p.live.snr) : '––'} unit="dB" />
            <Digit label="Distância" value={formatDistance(p.lastSample?.distance ?? null)} unit="do TX" />
            <Digit
              label="Altitude"
              value={p.lastSample?.altitude == null ? '––' : String(Math.round(p.lastSample.altitude))}
              unit={p.lastSample?.accuracy != null ? `m · ±${Math.round(p.lastSample.accuracy)} m` : 'm'}
            />
            <Digit label="Amostras" value={String(p.samples.length)} />
            <Digit label="Enlace" value={p.live?.linked ? 'vivo' : 'ausente'} />
          </div>

          <div className="rounded-xl border border-white/10 p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Posição do GPS</div>
            {p.fix ? (
              <>
                <div className="text-lg font-bold tabular-nums leading-tight">
                  {p.fix.latitude.toFixed(6)}
                </div>
                <div className="text-lg font-bold tabular-nums leading-tight">
                  {p.fix.longitude.toFixed(6)}
                </div>
                <div className="text-[11px] text-slate-500">
                  alt {p.fix.altitude == null ? '—' : `${Math.round(p.fix.altitude)} m`}
                  {p.fix.accuracy != null && ` · ±${Math.round(p.fix.accuracy)} m`}
                  {p.fix.accuracy != null && p.fix.accuracy > 50 && (
                    <b className="text-warning"> · impreciso, amostra descartada</b>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-warning">
                {p.gpsStatus ?? 'aguardando satélite — a céu aberto leva de 10 a 60 s'}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-white/10 p-3 space-y-2">
            <div className="text-sm font-semibold">Ponto do transmissor</div>
            <p className="text-xs text-slate-400">
              {p.origin
                ? `${p.origin.latitude.toFixed(6)}, ${p.origin.longitude.toFixed(6)} (${p.origin.source})`
                : 'sem origem — a distância só é calculada depois de marcar'}
            </p>
            <button onClick={p.onSetOriginHere} className="w-full rounded-lg bg-white/10 hover:bg-white/20 p-2 text-sm">
              Marcar aqui como transmissor
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={p.onOpenMap} className="rounded-xl bg-primary p-3 font-semibold">
              Mapa
            </button>
            <button
              onClick={() => {
                p.onStop();
                setMode('menu');
              }}
              className="rounded-xl bg-white/10 p-3"
            >
              Parar
            </button>
          </div>

          <div className="rounded-xl border border-white/10 p-3 text-xs">
            {p.fileId ? (
              <>
                <div className="text-slate-400">
                  Gravando em <b className="text-white">{p.fileName}</b> · {p.samples.length} pontos
                </div>
                {CloudSync.isConfigured() && (
                  <button onClick={handleUpload} className="mt-2 w-full rounded-lg bg-white/10 p-2">
                    Enviar para a nuvem
                  </button>
                )}
              </>
            ) : (
              <div className="text-warning">
                Sem arquivo aberto — os pontos estão só na memória. Volte e use
                <b> Criar arquivo</b> para gravar.
              </div>
            )}
          </div>

          <ConsolePanel onCommand={p.onSendCommand} connected={p.serialConnected} />

          <button onClick={p.onClear} className="w-full text-xs text-slate-500 underline">
            limpar amostras da sessão atual
          </button>
        </div>
      )}

      {mode === 'open' && (
        <div className="space-y-2">
          <button onClick={() => setMode('menu')} className="text-sm text-slate-400">
            ← voltar
          </button>

          {/* Aparelho e nuvem são listas diferentes de propósito.
              Misturá-las esconderia a única coisa que importa saber antes de
              abrir: se aquele trajeto ainda existe offline, ou se depende de
              rede para aparecer. */}
          {CloudSync.isConfigured() && (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1">
              <button
                onClick={() => setSource('device')}
                className={`rounded-lg py-2 text-sm font-semibold ${
                  source === 'device' ? 'bg-primary text-white' : 'text-slate-300'
                }`}
              >
                Aparelho ({saved.length})
              </button>
              <button
                onClick={() => {
                  setSource('cloud');
                  void refreshRemote();
                }}
                className={`rounded-lg py-2 text-sm font-semibold ${
                  source === 'cloud' ? 'bg-primary text-white' : 'text-slate-300'
                }`}
              >
                Nuvem ({remote.length})
              </button>
            </div>
          )}

          {source === 'cloud' && (
            <div className="space-y-2">
              <button
                onClick={() => void refreshRemote()}
                className="w-full rounded-lg bg-white/10 p-2 text-xs"
              >
                recarregar do banco
              </button>
              {!remote.length && (
                <p className="text-sm text-slate-400">
                  Nada na nuvem, ou sem rede. As campanhas do aparelho continuam
                  na outra aba.
                </p>
              )}
              {remote.map((r) => {
                const local = saved.find((x) => x.id === r.localId);
                return (
                  <div key={r.id} className="rounded-xl border border-white/10 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{r.name}</div>
                        <div className="text-xs text-slate-400">
                          {new Date(r.createdAt).toLocaleString('pt-BR')} · {r.band ?? '—'} ·{' '}
                          {r.samples} amostras
                        </div>
                        <div className="text-xs text-slate-400">
                          alcance máx {formatDistance(r.maxDistance)} · RSSI {r.worstRssi ?? '—'} a{' '}
                          {r.bestRssi ?? '—'} dBm
                        </div>
                        <div className="text-[11px] mt-1">
                          {local ? (
                            <span className="text-slate-500">
                              também no aparelho ({local.samples} pontos)
                            </span>
                          ) : (
                            <span className="text-warning">só na nuvem</span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <button
                          onClick={() => void openRemote(r)}
                          disabled={!r.samples}
                          className="rounded-lg bg-primary px-3 py-2 text-sm disabled:opacity-40"
                        >
                          Ver no mapa
                        </button>
                        <button
                          onClick={() => void removeRemote(r)}
                          className="rounded-lg border border-danger/50 text-danger px-3 py-2 text-xs"
                        >
                          apagar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {source === 'device' && !saved.length && (
            <p className="text-sm text-slate-400">Nenhuma campanha salva ainda.</p>
          )}
          {source === 'device' && saved.map((s) => (
            <div key={s.id} className="rounded-xl border border-white/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{s.name}</div>
                  <div className="text-xs text-slate-400">
                    {new Date(s.createdAt).toLocaleString('pt-BR')} · {s.band ?? '—'} · {s.samples} amostras
                  </div>
                  <div className="text-xs text-slate-400">
                    alcance máx {formatDistance(s.maxDistance)} · RSSI {s.worstRssi ?? '—'} a {s.bestRssi ?? '—'} dBm
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button onClick={() => handleOpen(s.id)} className="rounded-lg bg-primary px-3 py-2 text-sm">
                    Abrir
                  </button>
                  <button
                    onClick={async () => {
                      // A tela muda ANTES do await.
                      //
                      // Estava depois, e qualquer excecao la dentro — permissao
                      // de GPS, abertura da serial — deixava o botao sem efeito
                      // visivel nenhum: o usuario tocava e nada acontecia, sem
                      // erro em lugar algum.
                      setMode('live');
                      setBusy(`Continuando "${s.name}"…`);
                      try {
                        const full = await SessionStore.get(s.id);
                        if (!full) {
                          setBusy('Campanha nao encontrada no aparelho.');
                          return;
                        }
                        await p.continueFile(full);
                        setBusy(`Gravando em "${full.name}" — ${full.samples.length} pontos ja no arquivo.`);
                      } catch (e) {
                        setBusy(`Falha ao continuar: ${e instanceof Error ? e.message : e}`);
                      }
                    }}
                    className="rounded-lg bg-success/80 px-3 py-2 text-sm"
                  >
                    Continuar
                  </button>
                </div>
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                <button onClick={() => download(s.id, 'geojson')} className="underline text-slate-400">
                  GeoJSON
                </button>
                <button onClick={() => download(s.id, 'csv')} className="underline text-slate-400">
                  CSV
                </button>
                {CloudSync.isConfigured() && (
                  <button
                    onClick={async () => {
                      const full = await SessionStore.get(s.id);
                      if (!full) return;
                      setBusy('Enviando…');
                      const r = await CloudSync.upload(full);
                      setBusy(`Nuvem: ${r.message}`);
                    }}
                    className="underline text-slate-400"
                  >
                    enviar
                  </button>
                )}
                <button
                  onClick={async () => {
                    await SessionStore.remove(s.id);
                    refresh();
                  }}
                  className="underline text-danger ml-auto"
                >
                  apagar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
