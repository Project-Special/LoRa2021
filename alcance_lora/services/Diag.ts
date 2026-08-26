/**
 * Registro de diagnóstico visível no próprio app.
 *
 * POR QUE ISTO EXISTE
 *
 * O aparelho tem uma porta USB só. Quando a placa está ligada nela, não há
 * cabo para o PC — e sem cabo não há `adb`, nem logcat, nem console do
 * navegador. Justamente na hora em que algo dá errado com a serial, some toda
 * a ferramenta que serviria para descobrir o quê.
 *
 * Sem Wi-Fi no aparelho, `adb` por rede também não é opção. Então o log vem
 * para a tela: a pessoa lê ali mesmo, ou fotografa e manda.
 */

export interface DiagEntry {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

/** Cabe na tela e na memória; o que interessa é sempre o fim. */
const MAX = 80;

const entries: DiagEntry[] = [];
const listeners: Array<(e: DiagEntry[]) => void> = [];

function push(level: DiagEntry['level'], msg: string) {
  entries.push({ t: Date.now(), level, msg });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  const snapshot = [...entries];
  listeners.forEach((f) => f(snapshot));
  // Continua indo para o console também: quando HÁ cabo, é onde se lê melhor.
  const line = `[diag] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const Diag = {
  info: (m: string) => push('info', m),
  warn: (m: string) => push('warn', m),
  error: (m: string) => push('error', m),
  all: () => [...entries],
  clear: () => {
    entries.length = 0;
    listeners.forEach((f) => f([]));
  },
  subscribe(cb: (e: DiagEntry[]) => void): () => void {
    listeners.push(cb);
    cb([...entries]);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
  /** Texto puro, para copiar ou compartilhar. */
  asText(): string {
    return entries
      .map((e) => `${new Date(e.t).toLocaleTimeString('pt-BR')} ${e.level.toUpperCase()} ${e.msg}`)
      .join('\n');
  },
};
