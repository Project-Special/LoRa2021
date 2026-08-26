import { RadioState } from '../types';

/**
 * Estado do enlace LoRa, numa regra só.
 *
 * O LED de cada tela e a cor do rastro no mapa respondem à MESMA pergunta —
 * "havia comunicação aqui?" — e antes cada um respondia do seu jeito: a barra
 * de status pintava de amarelo o que o mapa já contava como perdido. Duas
 * respostas para uma pergunta só fazem o operador desconfiar das duas.
 *
 * Verde é comunicação viva. Vermelho é qualquer motivo de não haver: cabo
 * fechado, placa muda, ou enlace caído. O motivo continua escrito por extenso
 * ao lado — a cor decide, o texto explica.
 */
export type LinkLevel = 'ok' | 'down' | 'idle';

/**
 * Telemetria mais velha que isto e a placa parou de falar.
 *
 * O firmware em `quiet on` emite a 1 Hz; oito segundos são folga suficiente
 * para uma linha perdida não piscar o LED à toa.
 */
export const LINK_STALE_MS = 8000;

export const LINK_COLOR: Record<LinkLevel, string> = {
  ok: '#34C759',
  down: '#FF3B30',
  idle: '#64748b',
};

/** Cores do rastro — as mesmas do LED, de propósito. */
export const TRAIL_OK = LINK_COLOR.ok;
export const TRAIL_DOWN = LINK_COLOR.down;

export interface LinkInput {
  recording: boolean;
  serialConnected: boolean;
  live: RadioState | null;
  /** Idade da última telemetria, em ms. Infinity se nunca chegou. */
  telemetryAgeMs: number;
  /**
   * O que se vê na USB com a campanha parada.
   *
   * Sem isto o LED dizia só "parado" — mesmo com a placa plugada e o enlace
   * vivo do outro lado. O estado continua sendo "não estou lendo"; o que muda é
   * o motivo ficar dito, que é o que responde "posso começar?".
   */
  idleDetail?: string;
}

export function linkLevel(i: LinkInput): LinkLevel {
  // Parado não é falha: sem campanha rodando não há o que comunicar, e um LED
  // vermelho na tela inicial treinaria o operador a ignorar vermelho.
  if (!i.recording) return 'idle';
  if (!i.serialConnected) return 'down';
  if (!i.live || i.telemetryAgeMs > LINK_STALE_MS) return 'down';
  return i.live.linked ? 'ok' : 'down';
}

/** Por que o LED está nessa cor. É o que diz o que fazer a seguir. */
export function linkReason(i: LinkInput): string {
  if (!i.recording) return i.idleDetail || 'parado';
  if (!i.serialConnected) return 'sem cabo — verifique o OTG';
  if (!i.live) return 'aguardando telemetria';
  if (i.telemetryAgeMs > LINK_STALE_MS) {
    return `placa muda há ${Math.round(i.telemetryAgeMs / 1000)} s`;
  }
  if (!i.live.linked) return 'sem enlace LoRa';
  return `${i.live.rssi ?? '—'} dBm${i.live.band ? ` · ${i.live.band}` : ''}`;
}
