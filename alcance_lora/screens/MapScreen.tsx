import React, { useMemo, useState } from 'react';
import { RangeMap } from '../components/RangeMap';
import { RadioState, RangeSample, TxOrigin } from '../types';
import { Fix } from '../services/GeoService';
import { formatDistance, rssiColor } from '../lib/geo';
import { TRAIL_DOWN, TRAIL_OK } from '../lib/link';
import { LinkLed } from '../components/LinkLed';

interface Props {
  samples: RangeSample[];
  origin: TxOrigin | null;
  recording: boolean;
  fix: Fix | null;
  live: RadioState | null;
  serialConnected: boolean;
  telemetryAgeMs: number;
  idleDetail?: string;
  onBack: () => void;
}

const LEGEND = [-40, -60, -80, -100, -120];

export const MapScreen: React.FC<Props> = ({
  samples,
  origin,
  recording,
  fix,
  live,
  serialConnected,
  telemetryAgeMs,
  idleDetail,
  onBack,
}) => {
  const [follow, setFollow] = useState(true);

  const stats = useMemo(() => {
    const linked = samples.filter((s) => s.linked && s.distance != null);
    const withDist = samples.filter((s) => s.distance != null);
    const last = samples.length ? samples[samples.length - 1] : null;
    return {
      // O alcance que interessa é o maior ponto COM enlace. O maior ponto da
      // trilha pode ser onde o sinal já tinha caído e o operador seguiu andando.
      reach: linked.length ? Math.max(...linked.map((s) => s.distance as number)) : null,
      far: withDist.length ? Math.max(...withDist.map((s) => s.distance as number)) : null,
      last,
      lost: samples.filter((s) => !s.linked).length,
    };
  }, [samples]);

  return (
    <div className="fixed inset-0 flex flex-col">
      <div className="flex-1 relative">
        <RangeMap samples={samples} origin={origin} follow={follow && recording} fix={fix} />

        <button
          onClick={onBack}
          className="absolute left-3 z-[1000] rounded-full bg-black/70 text-white px-4 py-2 text-sm backdrop-blur"
          style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          ← Voltar
        </button>

        <div
          className="absolute left-1/2 -translate-x-1/2 z-[1000]"
          style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          <LinkLed
            recording={recording}
            serialConnected={serialConnected}
            live={live}
            telemetryAgeMs={telemetryAgeMs}
            idleDetail={idleDetail}
          />
        </div>

        <button
          onClick={() => setFollow((v) => !v)}
          className={`absolute right-3 z-[1000] rounded-full px-4 py-2 text-sm backdrop-blur ${
            follow ? 'bg-primary text-white' : 'bg-black/70 text-slate-300'
          }`}
          style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          {follow ? 'Seguindo' : 'Livre'}
        </button>

        <div className="absolute bottom-3 left-3 z-[1000] rounded-xl bg-black/70 backdrop-blur p-2 text-[10px] text-white">
          <div className="mb-1 opacity-70">RSSI (dBm)</div>
          <div className="flex items-center gap-1">
            {LEGEND.map((v) => (
              <div key={v} className="flex flex-col items-center gap-0.5">
                <span className="w-5 h-3 rounded" style={{ background: rssiColor(v) }} />
                <span className="tabular-nums opacity-70">{v}</span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-white/15 space-y-1 opacity-80">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-1 rounded" style={{ background: TRAIL_OK }} /> rastro com enlace
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="w-5 h-1 rounded"
                style={{ background: `repeating-linear-gradient(90deg, ${TRAIL_DOWN} 0 3px, transparent 3px 6px)` }}
              />{' '}
              rastro sem enlace
            </div>
          </div>
        </div>
      </div>

      <div
        className="bg-background-dark border-t border-white/10 p-3 grid grid-cols-4 gap-2 text-center"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div>
          <div className="text-[10px] uppercase text-slate-400">Alcance</div>
          <div className="text-lg font-bold tabular-nums">{formatDistance(stats.reach)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-400">Mais longe</div>
          <div className="text-lg font-bold tabular-nums">{formatDistance(stats.far)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-400">RSSI</div>
          <div className="text-lg font-bold tabular-nums">
            {stats.last?.rssi != null ? stats.last.rssi : '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-400">Pontos</div>
          <div className="text-lg font-bold tabular-nums">
            {samples.length}
            {stats.lost > 0 && <span className="text-danger text-xs"> /{stats.lost}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
