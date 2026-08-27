import React from 'react';

/**
 * Mostrador grande, portado de tools/serial.
 *
 * Por que trocar os cartões de número pequeno por isto: durante a campanha o
 * operador está andando e olhando o celular de relance, às vezes no sol. Um
 * número de 20 px num cartão de canto exige parar e focar; um número de 56 px
 * com uma barra embaixo se lê de esguelha, e a barra responde à pergunta que o
 * número sozinho não responde — "isso é bom ou ruim?" — sem obrigar a lembrar
 * que -72 dBm é razoável e -110 é o fim.
 *
 * A linguagem é a mesma do painel de bancada: rótulo micro espaçado, valor com
 * brilho, trilho afundado e preenchimento com gradiente. Duas telas do mesmo
 * projeto que mostram a mesma grandeza devem parecer a mesma coisa.
 */

interface Props {
  label: string;
  /** null = sem leitura. Diferente de zero, e mostrado como "––". */
  value: number | null;
  unit: string;
  /** 0..1. Quanto da barra preencher. */
  fill: number;
  /** Cor do valor e do preenchimento. */
  color: string;
  hint?: string;
}

export const Gauge: React.FC<Props> = ({ label, value, unit, fill, color, hint }) => {
  const has = value != null && Number.isFinite(value);
  const pct = has ? Math.max(0, Math.min(1, fill)) * 100 : 0;

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{label}</div>

      <div className="flex items-baseline gap-2 mt-1 mb-3">
        <output
          className="text-5xl font-bold leading-none tabular-nums"
          style={{
            // Sem leitura o número fica apagado em vez de colorido: "––" com o
            // brilho do valor bom sugeria uma medida que não existe.
            color: has ? color : '#64748b',
            textShadow: has ? `0 0 26px ${color}55` : 'none',
          }}
        >
          {has ? value : '––'}
        </output>
        <span className="text-lg text-slate-500">{unit}</span>
      </div>

      {/* Trilho afundado com preenchimento em gradiente. A transição curta faz
          a barra acompanhar sem parecer que está animando por conta própria. */}
      <div
        className="h-2.5 rounded-sm overflow-hidden"
        style={{ background: '#0c110f', boxShadow: 'inset 0 1px 3px #000, inset 0 0 0 1px #ffffff0a' }}
      >
        <div
          className="h-full transition-[width] duration-200 ease-out"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}44, ${color})`,
            boxShadow: `0 0 12px ${color}44`,
          }}
        />
      </div>

      {hint && <div className="text-[11px] text-slate-500 mt-2">{hint}</div>}
    </div>
  );
};

/** Linha de leitura secundária — o bloco "digits" do tools/serial. */
export const Digit: React.FC<{ label: string; value: string; unit?: string }> = ({
  label,
  value,
  unit,
}) => (
  <div className="flex items-baseline gap-3">
    <span className="min-w-[5.5rem] text-[10px] uppercase tracking-[0.18em] text-slate-400">
      {label}
    </span>
    <b className="text-xl font-bold tabular-nums">{value}</b>
    {unit && <i className="not-italic text-xs text-slate-500">{unit}</i>}
  </div>
);
