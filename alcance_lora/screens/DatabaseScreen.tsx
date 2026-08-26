import React, { useEffect, useMemo, useState } from 'react';
import { RangeMap } from '../components/RangeMap';
import { CloudSync, CloudSummary } from '../services/CloudSync';
import { SessionStore } from '../services/SessionStore';
import { Session } from '../types';
import { formatDistance, rssiColor } from '../lib/geo';
import { TRAIL_DOWN, TRAIL_OK } from '../lib/link';
import { exportText } from '../lib/exportFile';

/**
 * Consulta ao banco, com a tabela e o mapa lado a lado.
 *
 * Existe para a tela grande. No celular a pergunta é "onde estou e o enlace
 * está vivo?", e o mapa em tela cheia responde isso melhor que qualquer tabela.
 * No PC a pergunta é outra — "o que estes números dizem?" — e aí ver o ponto no
 * mapa e a linha da tabela ao mesmo tempo é o que permite achar o trecho onde o
 * sinal caiu e conferir coordenada, precisão do GPS e horário daquele ponto sem
 * trocar de tela.
 *
 * A fonte é sempre o Supabase, de propósito: aqui se olha a campanha que
 * QUALQUER aparelho gravou, inclusive as que já foram apagadas do celular.
 */

interface Props {
  onBack: () => void;
}

type Sort = 't' | 'distance' | 'rssi';

export const DatabaseScreen: React.FC<Props> = ({ onBack }) => {
  const [list, setList] = useState<CloudSummary[]>([]);
  const [selected, setSelected] = useState<CloudSummary | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>('Lendo o banco…');
  const [sort, setSort] = useState<Sort>('t');
  // A linha apontada na tabela é a mesma amostra realçada na lista. É o que
  // liga as duas metades da tela; sem isso são dois painéis independentes.
  const [hover, setHover] = useState<number | null>(null);

  const refresh = async () => {
    setBusy('Lendo o banco…');
    const rows = await CloudSync.listRemote();
    setList(rows);
    setBusy(rows.length ? null : 'Nada no banco, ou sem conexão.');
  };

  useEffect(() => {
    void refresh();
  }, []);

  const open = async (item: CloudSummary) => {
    setSelected(item);
    setSession(null);
    setBusy(`Baixando "${item.name}" — ${item.samples} pontos…`);
    const full = await CloudSync.download(item.id);
    if (!full) {
      setBusy('Falha ao baixar.');
      return;
    }
    setSession(full);
    setBusy(null);
  };

  /**
   * Apaga da nuvem. Pede confirmação NOMEANDO a campanha e o tamanho dela.
   *
   * Um "tem certeza?" genérico é ruído que se aprende a clicar sem ler. Dizer
   * "Lora1232 — 11 pontos" faz a pessoa reconhecer o que vai perder, que é a
   * única defesa real numa operação sem desfazer: a nuvem é a última cópia de
   * uma campanha que já foi apagada do celular.
   */
  const remove = async (item: CloudSummary) => {
    const ok = window.confirm(
      `Apagar "${item.name}" da nuvem?\n\n` +
        `${item.samples} pontos serão removidos junto. Não há como desfazer.`,
    );
    if (!ok) return;

    setBusy(`Apagando "${item.name}"…`);
    const r = await CloudSync.deleteRemote(item.id);
    setBusy(r.message);
    if (!r.ok) {
      // Ver HomeScreen: falha de ação destrutiva não pode ser discreta.
      window.alert(r.message);
      return;
    }

    setList((prev) => prev.filter((x) => x.id !== item.id));
    if (selected?.id === item.id) {
      setSelected(null);
      setSession(null);
    }
  };

  const rows = useMemo(() => {
    if (!session) return [];
    const copy = [...session.samples];
    if (sort === 'distance') copy.sort((a, b) => (b.distance ?? -1) - (a.distance ?? -1));
    else if (sort === 'rssi') copy.sort((a, b) => (a.rssi ?? 0) - (b.rssi ?? 0));
    return copy;
  }, [session, sort]);

  const stats = useMemo(() => {
    if (!session) return null;
    const linked = session.samples.filter((s) => s.linked && s.distance != null);
    const rssi = session.samples.map((s) => s.rssi).filter((v): v is number => v != null);
    return {
      total: session.samples.length,
      lost: session.samples.filter((s) => !s.linked).length,
      // O alcance que interessa é o ponto mais longe COM enlace. O mais longe
      // da trilha pode ser onde o sinal já tinha caído e o operador seguiu.
      reach: linked.length ? Math.max(...linked.map((s) => s.distance as number)) : null,
      best: rssi.length ? Math.max(...rssi) : null,
      worst: rssi.length ? Math.min(...rssi) : null,
      semRssi: session.samples.length - rssi.length,
    };
  }, [session]);

  const save = async (kind: 'csv' | 'geojson') => {
    if (!session) return;
    const body = kind === 'csv' ? SessionStore.toCSV(session) : SessionStore.toGeoJSON(session);
    const name = `${session.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.${kind}`;
    const r = await exportText(name, kind === 'csv' ? 'text/csv' : 'application/geo+json', body);
    setBusy(r.message);
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-background-dark">
      <header
        className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">
          ← Voltar
        </button>
        <h1 className="text-lg font-bold">Banco de dados</h1>
        <button
          onClick={() => void refresh()}
          className="ml-auto rounded-lg bg-white/10 px-3 py-1.5 text-xs"
        >
          recarregar
        </button>
      </header>

      {busy && (
        <div className="px-4 py-2 text-sm bg-primary/15 border-b border-primary/30 shrink-0">
          {busy}
        </div>
      )}

      {/* Uma coluna no estreito, duas no largo. A lista de campanhas é curta e
          não merece metade de um monitor. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr]">
        <aside className="border-r border-white/10 overflow-y-auto p-3 space-y-2 max-h-48 lg:max-h-none lg:pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
          {!list.length && <p className="text-sm text-slate-400">Nenhuma campanha.</p>}
          {/* div, e não button: um <button> dentro de outro é HTML inválido, e
              o navegador desfaz o aninhamento de um jeito que deixa o apagar
              inalcançável. */}
          {list.map((r) => (
            <div
              key={r.id}
              className={`rounded-xl border p-3 transition ${
                selected?.id === r.id
                  ? 'border-primary bg-primary/15'
                  : 'border-white/10 hover:bg-white/5'
              }`}
            >
              <button
                onClick={() => void open(r)}
                disabled={!r.samples}
                className="w-full text-left disabled:opacity-40"
              >
                <div className="font-semibold truncate">{r.name}</div>
                <div className="text-xs text-slate-400">
                  {new Date(r.createdAt).toLocaleString('pt-BR')} · {r.band || '—'}
                </div>
                <div className="text-xs text-slate-400">
                  {r.samples} pontos · {formatDistance(r.maxDistance)}
                </div>
              </button>
              <button
                onClick={() => void remove(r)}
                className="mt-2 text-[11px] text-danger underline"
              >
                apagar da nuvem
              </button>
            </div>
          ))}
        </aside>

        <main className="min-h-0 flex flex-col">
          {!session ? (
            <div className="flex-1 grid place-items-center text-slate-500 text-sm p-8 text-center">
              Escolha uma campanha à esquerda para ver o trajeto e os pontos.
            </div>
          ) : (
            <>
              <div className="h-[45%] min-h-[220px] relative border-b border-white/10">
                <RangeMap samples={session.samples} origin={session.origin} follow={false} fix={null} />
              </div>

              {stats && (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-3 text-center border-b border-white/10 shrink-0">
                  <Cell label="Pontos" value={String(stats.total)} />
                  <Cell label="Alcance" value={formatDistance(stats.reach)} />
                  <Cell
                    label="Sem enlace"
                    value={String(stats.lost)}
                    tone={stats.lost ? 'bad' : undefined}
                  />
                  <Cell label="Melhor RSSI" value={stats.best == null ? '—' : String(stats.best)} />
                  <Cell label="Pior RSSI" value={stats.worst == null ? '—' : String(stats.worst)} />
                  {/* Ponto sem RSSI é ponto que chegou com a telemetria quebrada.
                      Mostrar o número evita ler melhor/pior como se fosse do total. */}
                  <Cell
                    label="Sem RSSI"
                    value={String(stats.semRssi)}
                    tone={stats.semRssi ? 'warn' : undefined}
                  />
                </div>
              )}

              <div className="px-3 py-2 flex items-center gap-2 text-xs shrink-0">
                <span className="text-slate-400">ordenar:</span>
                {(['t', 'distance', 'rssi'] as Sort[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={`rounded-lg px-2 py-1 ${
                      sort === k ? 'bg-primary text-white' : 'bg-white/10 text-slate-300'
                    }`}
                  >
                    {k === 't' ? 'tempo' : k === 'distance' ? 'distância' : 'RSSI'}
                  </button>
                ))}
                <div className="ml-auto flex gap-3">
                  <button onClick={() => void save('csv')} className="underline text-slate-400">
                    CSV
                  </button>
                  <button onClick={() => void save('geojson')} className="underline text-slate-400">
                    GeoJSON
                  </button>
                </div>
              </div>

              {/* Espaço de rolagem por baixo da barra do Android.
                  A tela é `fixed inset-0`, então ela ignora o padding de área
                  segura do <body> — e a barra de navegação ficava POR CIMA das
                  últimas linhas. Como padding dentro de um container rolável, o
                  espaço vira rolagem extra: a última linha sobe até ficar
                  visível em vez de ser recortada. */}
              <div
                className="flex-1 min-h-0 overflow-auto"
                style={{ paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom))' }}
              >
                <table className="w-full text-xs tabular-nums">
                  <thead className="sticky top-0 bg-background-dark text-slate-400">
                    <tr className="text-left">
                      <th className="p-2 font-medium">hora</th>
                      <th className="p-2 font-medium">latitude</th>
                      <th className="p-2 font-medium">longitude</th>
                      <th className="p-2 font-medium">alt</th>
                      <th className="p-2 font-medium">± m</th>
                      <th className="p-2 font-medium">dist</th>
                      <th className="p-2 font-medium">RSSI</th>
                      <th className="p-2 font-medium">SNR</th>
                      <th className="p-2 font-medium">LQ</th>
                      <th className="p-2 font-medium">enlace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s, i) => (
                      <tr
                        key={`${s.t}-${i}`}
                        onMouseEnter={() => setHover(s.t)}
                        onMouseLeave={() => setHover(null)}
                        className={`border-t border-white/5 ${
                          hover === s.t ? 'bg-white/10' : i % 2 ? 'bg-white/[0.02]' : ''
                        }`}
                      >
                        <td className="p-2">{new Date(s.t).toLocaleTimeString('pt-BR')}</td>
                        <td className="p-2">{s.latitude.toFixed(6)}</td>
                        <td className="p-2">{s.longitude.toFixed(6)}</td>
                        <td className="p-2">{s.altitude == null ? '—' : Math.round(s.altitude)}</td>
                        <td className="p-2 text-slate-500">
                          {s.accuracy == null ? '—' : Math.round(s.accuracy)}
                        </td>
                        <td className="p-2">{formatDistance(s.distance)}</td>
                        <td className="p-2">
                          {s.rssi == null ? (
                            <span className="text-warning">—</span>
                          ) : (
                            <span style={{ color: rssiColor(s.rssi) }}>{s.rssi}</span>
                          )}
                        </td>
                        <td className="p-2">{s.snr ?? '—'}</td>
                        <td className="p-2">{s.lq ?? '—'}</td>
                        <td className="p-2">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full"
                            style={{ background: s.linked ? TRAIL_OK : TRAIL_DOWN }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
};

const Cell: React.FC<{ label: string; value: string; tone?: 'bad' | 'warn' }> = ({
  label,
  value,
  tone,
}) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
    <div
      className={`text-lg font-bold tabular-nums ${
        tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : ''
      }`}
    >
      {value}
    </div>
  </div>
);
