/**
 * Decodificador de CRSF -- o dialeto que o receptor ExpressLRS fala.
 *
 * A bancada original emitia texto (`$T rssi=-93.0 ...`), legivel num monitor
 * serial. O receptor ELRS nao: ele fala CRSF binario, o mesmo protocolo do
 * controlador de voo. Nenhum `$T` sai dele, e por isso o app conectava, lia
 * bytes e continuava dizendo "sem enlace lora" -- o cabo estava certo, o baud
 * estava certo, e o app so nao entendia o idioma.
 *
 * Quadro CRSF:
 *
 *     [endereco] [tam] [tipo] [carga ...] [crc8]
 *                 \_ conta de `tipo` ate `crc8`, inclusive
 *
 * O CRC e um CRC-8 de polinomio 0xD5 sobre `tipo` + carga. Ele importa: a
 * serial nao tem enquadramento, entao um byte de carga pode parecer um
 * endereco. Sem conferir o CRC, um quadro falso vira leitura falsa -- e uma
 * leitura falsa de RSSI contamina a campanha inteira.
 */

const CRSF_ENDERECOS = new Set([0xc8, 0xea, 0xec, 0xee]);
const TIPO_LINK_STATISTICS = 0x14;
const TIPO_RC_CHANNELS = 0x16;

function crc8(b: Uint8Array, ini: number, fim: number): number {
  let c = 0;
  for (let i = ini; i < fim; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0xd5) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export interface CrsfLink {
  /** dBm, sempre negativo. Ausente enquanto nao houver leitura. */
  rssi?: number;
  snr?: number;
  lq?: number;
  linked: boolean;
  /** Taxa de pacotes em Hz, deduzida do rf_Mode que o receptor informa. */
  hz?: number;
  sf?: number;
  bw?: number;
  cr?: number;
  /** dBm, do indice de potencia que o CRSF carrega. */
  power?: number;
  /** Banda assumida, nao medida -- ver setBandaCrsf. */
  banda?: string;
}

/**
 * rf_Mode e o `enum_rate` do ExpressLRS, nao um indice de tabela. Os parametros
 * de modem vem da tabela de 2,4 GHz do LR2021 (common.cpp) -- e o receptor quem
 * diz em qual taxa esta, entao nada aqui e chutado a partir da configuracao
 * local, que pode estar defasada.
 */
const TAXAS_2G4: Record<number, { hz: number; sf: number; bw: number; cr: number }> = {
  2: { hz: 50, sf: 8, bw: 812.5, cr: 8 },   // RATE_LORA_50HZ
  4: { hz: 100, sf: 7, bw: 812.5, cr: 8 },  // RATE_LORA_100HZ_8CH
  5: { hz: 150, sf: 7, bw: 812.5, cr: 8 },  // RATE_LORA_150HZ
  7: { hz: 250, sf: 6, bw: 812.5, cr: 8 },  // RATE_LORA_250HZ
  8: { hz: 333, sf: 5, bw: 812.5, cr: 8 },  // RATE_LORA_333HZ_8CH
  9: { hz: 500, sf: 5, bw: 812.5, cr: 6 },  // RATE_LORA_500HZ
};

/**
 * As taxas sub-GHz. Existem porque `rf_Mode` NAO desempata a banda: o mesmo
 * RATE_LORA_50HZ aparece nas duas tabelas do firmware, com parametros bem
 * diferentes -- SF8/500 kHz/CR4:7 aqui, SF8/812,5 kHz/CR4:8 em 2,4 GHz. Uma
 * tabela so faria o app anunciar o modem errado ao trocar de banda.
 */
const TAXAS_SUBG: Record<number, { hz: number; sf: number; bw: number; cr: number }> = {
  2: { hz: 50, sf: 8, bw: 500, cr: 7 },     // RATE_LORA_50HZ
  3: { hz: 100, sf: 7, bw: 500, cr: 7 },    // RATE_LORA_100HZ
  4: { hz: 100, sf: 6, bw: 500, cr: 8 },    // RATE_LORA_100HZ_8CH
  6: { hz: 200, sf: 6, bw: 500, cr: 7 },    // RATE_LORA_200HZ
};

/**
 * O CRSF carrega POTENCIA como indice, nao como numero. A tabela e do proprio
 * protocolo (mW), e o app trabalha em dBm -- converte-se aqui, uma vez, em vez
 * de espalhar 10*log10 pela interface.
 */
const POTENCIA_MW: Record<number, number> = {
  0: 0, 1: 10, 2: 25, 3: 100, 4: 500, 5: 1000, 6: 2000, 7: 50, 8: 250,
};

/**
 * Banda em uso, para desempatar o rf_Mode. Comeca em 2,4 GHz porque e a taxa de
 * fabrica deste projeto; muda quando o painel disser outra.
 */
let bandaAtual: string = '2g4';

export function setBandaCrsf(b: string) {
  bandaAtual = b;
}

export class CrsfDecoder {
  private buf = new Uint8Array(0);
  /** Quadros de canais vistos: prova de que ha enlace, e nao so cabo. */
  private rcVistos = 0;

  constructor(private readonly emit: (l: CrsfLink) => void) {}

  /** Quantos quadros de RC chegaram desde a ultima chamada. */
  drenarRc(): number {
    const n = this.rcVistos;
    this.rcVistos = 0;
    return n;
  }

  push(chunk: Uint8Array) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);

    let i = 0;
    while (i + 4 <= b.length) {
      if (!CRSF_ENDERECOS.has(b[i])) { i++; continue; }
      const tam = b[i + 1];
      if (tam < 2 || tam > 62) { i++; continue; }
      if (i + tam + 2 > b.length) break;          // quadro incompleto: espera mais
      if (crc8(b, i + 2, i + tam + 1) !== b[i + tam + 1]) { i++; continue; }

      const tipo = b[i + 2];
      if (tipo === TIPO_RC_CHANNELS) this.rcVistos++;
      else if (tipo === TIPO_LINK_STATISTICS && tam >= 12) this.emit(this.lerLink(b, i + 3));
      i += tam + 2;
    }

    // Guarda so o resto. Um buraco grande sem quadro valido e lixo, nao dado.
    this.buf = b.slice(i > b.length - 64 ? i : b.length - 64);
  }

  private lerLink(b: Uint8Array, p: number): CrsfLink {
    const rssiPos = b[p];                       // dBm positivado pelo CRSF
    const lq = b[p + 2];
    const snr = b[p + 3] > 127 ? b[p + 3] - 256 : b[p + 3];
    // Sem a banda no quadro, a ambiguidade do rf_Mode e insoluvel pelo CRSF.
    // Resolve-se por fora: quem sabe a banda e o painel, e o app so usa este
    // decodificador no caminho do CABO -- onde a banda vem de setBanda().
    const modo = (bandaAtual === '2g4' ? TAXAS_2G4 : TAXAS_SUBG)[b[p + 5]];
    const mw = POTENCIA_MW[b[p + 6]];

    // rssiPos === 0 nao e "0 dBm", que nao existe em LoRa -- e ausencia de
    // leitura. Mesma regra do resto do projeto: campo ausente, nao zero.
    const temLeitura = rssiPos > 0 && lq > 0;
    return {
      rssi: temLeitura ? -rssiPos : undefined,
      snr: temLeitura ? snr : undefined,
      lq: temLeitura ? lq : undefined,
      linked: temLeitura,
      hz: modo?.hz,
      sf: modo?.sf,
      bw: modo?.bw,
      cr: modo?.cr,
      banda: bandaAtual,
      power: mw ? Math.round(10 * Math.log10(mw)) : undefined,
    };
  }
}
