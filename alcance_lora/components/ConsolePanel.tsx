import React, { useEffect, useRef, useState } from 'react';
import { Diag, DiagEntry } from '../services/Diag';

/**
 * Console da placa e diagnóstico, dentro do app.
 *
 * O aparelho tem uma porta USB só: com a placa ligada nela não há cabo para o
 * PC, e sem cabo não existe monitor serial nem logcat. Todo o console do
 * firmware — `stats`, `rssi`, `pwr`, `peer` — ficaria inacessível justamente
 * em campo, que é onde as perguntas aparecem.
 */

interface Props {
  onCommand: (cmd: string) => Promise<void>;
  connected: boolean;
}

/** Os comandos que se usa em campo, sem ter de lembrar a grafia. */
const QUICK = ['tel', 'stats', 'rssi', 'info', 'quiet off', 'quiet on'];

const COLOR: Record<DiagEntry['level'], string> = {
  info: 'text-slate-300',
  warn: 'text-warning',
  error: 'text-danger',
};

export const ConsolePanel: React.FC<Props> = ({ onCommand, connected }) => {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [cmd, setCmd] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => Diag.subscribe(setEntries), []);
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries, open]);

  const send = async (text: string) => {
    const c = text.trim();
    if (!c) return;
    Diag.info(`> ${c}`);
    setCmd('');
    try {
      await onCommand(c);
    } catch (e) {
      Diag.error(`envio falhou: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm bg-white/5"
      >
        <span className="font-semibold">Console e diagnóstico</span>
        <span className="text-xs text-slate-400">
          {entries.length} linha(s) {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="p-2 space-y-2">
          <div className="h-56 overflow-y-auto rounded-lg bg-black/50 p-2 font-mono text-[10px] leading-relaxed">
            {entries.length === 0 && <div className="text-slate-500">sem registros ainda</div>}
            {entries.map((e, i) => (
              <div key={i} className={COLOR[e.level]}>
                <span className="text-slate-600">
                  {new Date(e.t).toLocaleTimeString('pt-BR')}{' '}
                </span>
                {e.msg}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <div className="flex flex-wrap gap-1">
            {QUICK.map((q) => (
              <button
                key={q}
                onClick={() => void send(q)}
                disabled={!connected}
                className="rounded-md bg-white/10 px-2 py-1 text-[11px] font-mono disabled:opacity-40"
              >
                {q}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send(cmd);
              }}
              placeholder={connected ? 'comando (ex: pwr 22)' : 'placa não conectada'}
              disabled={!connected}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 rounded-lg bg-black/40 border border-white/10 p-2 text-xs font-mono text-white disabled:opacity-40"
            />
            <button
              onClick={() => void send(cmd)}
              disabled={!connected}
              className="rounded-lg bg-primary px-3 text-xs font-semibold disabled:opacity-40"
            >
              Enviar
            </button>
          </div>

          <div className="flex gap-2 text-[11px]">
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(Diag.asText());
                  Diag.info('log copiado');
                } catch {
                  Diag.warn('não foi possível copiar');
                }
              }}
              className="underline text-slate-400"
            >
              copiar log
            </button>
            <button onClick={() => Diag.clear()} className="underline text-slate-400 ml-auto">
              limpar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
