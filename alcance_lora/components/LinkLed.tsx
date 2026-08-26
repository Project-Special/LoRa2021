import React from 'react';
import { LINK_COLOR, LinkInput, LinkLevel, linkLevel, linkReason } from '../lib/link';

/**
 * LED de comunicação LoRa, presente em toda tela.
 *
 * Num teste de alcance o operador está andando e olhando o celular de relance,
 * às vezes no sol. Ler "sem telemetria há alguns segundos" nessas condições não
 * acontece; ver que a bolinha virou vermelha, sim. O texto fica ao lado para
 * quando ele parar e quiser saber o motivo.
 */

const Led: React.FC<{ level: LinkLevel; size: number }> = ({ level, size }) => {
  const c = LINK_COLOR[level];
  return (
    <span
      className={`rounded-full shrink-0 ${level === 'ok' ? 'animate-pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: c,
        // O halo é o que faz o ponto ser visto de relance, e some no cinza:
        // "parado" não deve competir por atenção com "caiu".
        boxShadow: level === 'idle' ? 'none' : `0 0 ${size * 0.9}px ${c}`,
      }}
    />
  );
};

interface Props extends LinkInput {
  /** Só a bolinha, para cantos apertados como o mapa. */
  compact?: boolean;
  className?: string;
}

export const LinkLed: React.FC<Props> = ({
  compact,
  className = '',
  recording,
  serialConnected,
  live,
  telemetryAgeMs,
  idleDetail,
}) => {
  const input: LinkInput = { recording, serialConnected, live, telemetryAgeMs, idleDetail };
  const level = linkLevel(input);
  const reason = linkReason(input);
  const title = `LoRa: ${level === 'ok' ? 'comunicando' : level === 'down' ? 'sem comunicação' : 'parado'} — ${reason}`;

  if (compact) {
    return (
      <span className={`inline-flex items-center ${className}`} title={title}>
        <Led level={level} size={12} />
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full bg-black/40 border border-white/10 px-3 py-1.5 backdrop-blur ${className}`}
      title={title}
    >
      <Led level={level} size={10} />
      <span className="text-[10px] uppercase tracking-wider text-slate-400 leading-none">LoRa</span>
      <span className="text-xs leading-none truncate max-w-[10rem]" style={{ color: LINK_COLOR[level] }}>
        {reason}
      </span>
    </div>
  );
};
