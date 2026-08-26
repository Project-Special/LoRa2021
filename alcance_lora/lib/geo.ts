/** Raio médio da Terra, em metros (IUGG). */
const EARTH_R = 6371008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Distância em linha reta sobre a superfície, em metros.
 *
 * Haversine, não a fórmula plana: nas distâncias de um teste de alcance a
 * diferença ainda é pequena, mas a plana erra mais quanto mais longe do
 * equador — e o erro cresce justamente nos pontos mais interessantes, os
 * distantes.
 */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distância 3D, incluindo o desnível.
 *
 * Num teste de alcance a altura importa: subir um morro de 100 m com 300 m de
 * afastamento horizontal dá 316 m de caminho real, e é esse o número que
 * explica o RSSI. Sem a altitude, cai no cálculo horizontal.
 */
export function distance3d(
  lat1: number,
  lon1: number,
  alt1: number | null,
  lat2: number,
  lon2: number,
  alt2: number | null,
): number {
  const flat = haversine(lat1, lon1, lat2, lon2);
  if (alt1 == null || alt2 == null) return flat;
  const dz = alt2 - alt1;
  return Math.sqrt(flat * flat + dz * dz);
}

/** "1,24 km" ou "840 m" — a unidade que couber. */
export function formatDistance(m: number | null): string {
  if (m == null) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2).replace('.', ',')} km`;
}

/**
 * Cor da amostra pelo RSSI, do verde ao vermelho.
 *
 * A escala vai de -40 dBm (colado) a -120 dBm (no limite da sensibilidade), que
 * é a faixa útil de LoRa. Fora dela satura nas pontas em vez de sair da escala.
 */
export function rssiColor(rssi: number | null): string {
  if (rssi == null) return '#64748b';
  const clamped = Math.max(-120, Math.min(-40, rssi));
  // 0 = pior, 1 = melhor
  const k = (clamped + 120) / 80;
  // Vermelho -> amarelo -> verde, em HSL: 0deg a 120deg
  return `hsl(${Math.round(k * 120)}, 85%, 45%)`;
}
