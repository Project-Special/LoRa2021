import React from 'react';
import { Fix } from '../services/GeoService';
import { RadioState } from '../types';
import { serialLevel, serialReason } from '../lib/link';
import { CloudState } from '../hooks/useRangeSession';

/**
 * Estado das duas fontes, sempre à vista.
 *
 * O app depende de dois canais independentes — GPS do celular e placa pela
 * serial — e quando não aparecem pontos, a pergunta é sempre "qual dos dois
 * está faltando?". Sem isso na tela, "0 amostras" não distingue GPS sem
 * satélite de cabo desconectado, e as duas causas pedem ações opostas: uma se
 * resolve indo para céu aberto, a outra mexendo no cabo.
 */

type Level = 'ok' | 'wait' | 'bad';

const COLOR: Record<Level, string> = {
  ok: 'bg-success',
  wait: 'bg-warning',
  bad: 'bg-danger',
};

const Chip: React.FC<{ level: Level; label: string; detail: string }> = ({ level, label, detail }) => (
  <div className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2 flex items-center gap-2 min-w-0">
    <span
      className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR[level]} ${
        level === 'wait' ? 'animate-pulse' : ''
      }`}
    />
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-slate-400 leading-none">{label}</div>
      <div className="text-xs truncate">{detail}</div>
    </div>
  </div>
);

interface Props {
  fix: Fix | null;
  gpsStatus: string | null;
  live: RadioState | null;
  serialConnected: boolean;
  transport: string;
  /** Idade da última telemetria, em ms. Infinity se nunca chegou. */
  telemetryAgeMs: number;
  recording: boolean;
  cloud: CloudState;
  cloudMessage: string;
  usbInfo: string;
  usbPresent: boolean;
}

/** Precisão acima disto e a amostra é descartada; o chip precisa avisar antes. */
const ACC_LIMIT = 50;

export const StatusBar: React.FC<Props> = (p) => {
  let gpsLevel: Level = 'wait';
  let gpsDetail = p.gpsStatus ?? 'procurando satélite';
  if (p.fix) {
    const acc = p.fix.accuracy;
    if (acc != null && acc > ACC_LIMIT) {
      gpsLevel = 'wait';
      gpsDetail = `±${Math.round(acc)} m — impreciso demais`;
    } else {
      gpsLevel = 'ok';
      gpsDetail = `${p.fix.latitude.toFixed(5)}, ${p.fix.longitude.toFixed(5)}${
        acc != null ? ` ±${Math.round(acc)} m` : ''
      }`;
    }
  } else if (!p.recording) {
    // "parado" sozinho parece defeito. Dizer o que falta transforma a mesma
    // informação em instrução.
    gpsDetail = 'parado — inicie a campanha';
  }

  // Esta fita responde pela PLACA, não pelo enlace de rádio — ver serialLevel
  // em lib/link. O enlace aparece aqui como detalhe escrito; quem o julga com
  // cor é o LED de LoRa, logo acima.
  const link = {
    recording: p.recording,
    serialConnected: p.serialConnected,
    live: p.live,
    telemetryAgeMs: p.telemetryAgeMs,
    idleDetail: p.usbInfo,
  };
  const lvl = serialLevel(link);
  const serLevel: Level =
    lvl === 'ok' ? 'ok' : lvl === 'bad' ? 'bad' : lvl === 'idle' && p.usbPresent ? 'ok' : 'wait';
  const serDetail = serialReason(link);

  // A nuvem é a terceira fonte, e merece o mesmo tratamento das outras duas:
  // "os pontos estão salvos fora do aparelho?" é uma pergunta que só se lembra
  // de fazer quando já é tarde. Sem rede NÃO é vermelho — é o estado normal de
  // um teste de alcance, e a gravação local segue de pé.
  const cloudLevel: Level =
    p.cloud === 'synced' ? 'ok' : p.cloud === 'error' ? 'bad' : 'wait';

  return (
    <div className="grid grid-cols-2 gap-2">
      <Chip level={gpsLevel} label="GPS" detail={gpsDetail} />
      <Chip level={serLevel} label={`Placa · ${p.transport}`} detail={serDetail} />
      <div className="col-span-2">
        <Chip level={cloudLevel} label="Nuvem" detail={p.cloudMessage} />
      </div>
    </div>
  );
};
