export enum ScreenName {
  HOME = 'HOME',
  MAP = 'MAP',
  /** Consulta ao banco: campanhas de qualquer aparelho, tabela e mapa juntos. */
  DATABASE = 'DATABASE',
}

/** Uma amostra: onde o celular estava e o que o rádio estava ouvindo ali. */
export interface RangeSample {
  /** ms desde a época. Também serve de chave de ordenação. */
  t: number;
  latitude: number;
  longitude: number;
  /** metros acima do elipsoide, como o GPS reporta. null quando indisponível. */
  altitude: number | null;
  /** precisão horizontal do GPS, em metros. Amostra com precisão ruim mente. */
  accuracy: number | null;
  /** dBm do último quadro recebido. */
  rssi: number | null;
  snr: number | null;
  /** 0..100. Vem do receptor quando ele sabe contar perdidos. */
  lq: number | null;
  /** true = havia enlace no instante da amostra. */
  linked: boolean;
  /**
   * Metros até o ponto do transmissor, em linha reta.
   *
   * Guardado junto com a amostra, e não calculado na hora de exibir, porque a
   * origem pode ser movida depois — e aí o histórico passaria a mostrar
   * distâncias que nunca foram medidas.
   */
  distance: number | null;
}

/** O ponto onde o transmissor ficou parado durante a campanha. */
export interface TxOrigin {
  latitude: number;
  longitude: number;
  altitude: number | null;
  /** Como a origem foi definida — muda o quanto confiar na distância. */
  source: 'gps' | 'manual';
}

export interface Session {
  id: string;
  name: string;
  createdAt: number;
  /** Banda e modem no momento da campanha, pra comparar sessões depois. */
  band: string | null;
  freqMHz: number | null;
  powerDbm: number | null;
  origin: TxOrigin | null;
  samples: RangeSample[];
}

/** Resumo pra listar sessões sem carregar todas as amostras. */
export interface SessionSummary {
  id: string;
  name: string;
  createdAt: number;
  band: string | null;
  samples: number;
  maxDistance: number | null;
  bestRssi: number | null;
  worstRssi: number | null;
}

/** Estado bruto que o firmware devolve em GET /api/state. */
export interface RadioState {
  node: string;
  band: string;
  freq: number;
  sf: number;
  bw: number;
  cr: number;
  power: number;
  rssi?: number;
  snr?: number;
  lq?: number;
  linked: boolean;
  radioOk: boolean;
  /** Indice da taxa em uso. So chega pelo painel (WiFi); o CRSF nao o carrega. */
  rate?: number;
  /** Taxas que o firmware aceita, com a banda de cada uma. */
  rates?: Array<{ i: number; hz: number; b: string; c8?: number }>;
  /** Plano de banda sub-GHz em uso, e os que o firmware conhece. */
  domain?: number;
  domains?: Array<{ i: number; nome: string; mhz: number; ch: number; ok?: boolean }>;
  /** Niveis de potencia com o dBm MEDIDO de cada um (datasheet do modulo). */
  powers?: Array<{ i: number; dbm: number }>;
}

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'error';
