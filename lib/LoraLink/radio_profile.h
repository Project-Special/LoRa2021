#pragma once

#include <Arduino.h>

// Band presets for the LR2021.
//
// Limites impostos pelo próprio rádio (LoraLink devolve
// ERR_INVALID_FREQUENCY / ERR_INVALID_OUTPUT_POWER fora deles):
//   Sub-GHz  150.0 .. 1090.0 MHz   TX power  -9 .. +22 dBm
//   S-band  1900.0 .. 2200.0 MHz   TX power -19 .. +12 dBm
//   2.4 GHz 2400.0 .. 2500.0 MHz   TX power -19 .. +12 dBm
//
// Accepted LoRa bandwidths (kHz):
//   31.25, 41.67, 62.5, 83.33, 100, 125, 203.125, 250, 406.25, 500, 812.5, 1000
// Spreading factor 5..12, coding rate 4..8 (denominator of 4/N).

enum BandId : uint8_t {
  BAND_150 = 0,
  BAND_433,
  BAND_470,
  BAND_868,
  BAND_915,
  BAND_SBAND,
  BAND_2G4,
  BAND_COUNT
};

struct BandProfile {
  const char* name;
  const char* alias;      // short token accepted by the serial console
  float frequencyMHz;
  float bandwidthKHz;
  uint8_t spreadingFactor;
  uint8_t codingRate;     // 4/N, N = 4..8
  int8_t powerDbm;
  uint8_t syncWord;
  bool highFreq;          // true => 2.4 GHz / S-band RF path and PA limits
  const char* note;
};

// Sync word 0x12 = private network, 0x34 = public LoRaWAN.
static const BandProfile kBandProfiles[BAND_COUNT] = {
    {"150 MHz", "150", 150.0f, 125.0f, 9, 7, 22, 0x12, false,
     "Posição mais baixa da matriz do módulo — uso licenciado"},
    {"433 MHz ISM", "433", 433.0f, 125.0f, 9, 7, 22, 0x12, false,
     "ISM região 1 / radioamador — conferir ciclo de trabalho local"},
    {"470 MHz", "470", 470.0f, 125.0f, 9, 7, 22, 0x12, false,
     "Plano de banda CN470"},
    {"868 MHz EU", "868", 868.1f, 125.0f, 9, 7, 14, 0x12, false,
     "EU868 — limite de +14 dBm ERP, 1% de ciclo de trabalho"},
    {"915 MHz AU/US", "915", 915.0f, 125.0f, 9, 7, 20, 0x12, false,
     "AU915 / US915 — é o plano usado no Brasil"},
    {"S-band 2.1 GHz", "sband", 2100.0f, 125.0f, 10, 7, 12, 0x12, true,
     "Banda de satélite LICENCIADA — só laboratório / teste"},
    {"2.4 GHz ISM", "2g4", 2450.0f, 203.125f, 12, 7, 12, 0x12, true,
     "ISM mundial — banda larga, vazão bem maior"},
};

inline const BandProfile& bandProfile(BandId id) {
  return kBandProfiles[id < BAND_COUNT ? id : BAND_915];
}

// Resolve a console token ("868", "2g4", ...) to a band id.
inline bool bandFromAlias(const String& token, BandId& out) {
  for (uint8_t i = 0; i < BAND_COUNT; i++) {
    if (token.equalsIgnoreCase(kBandProfiles[i].alias)) {
      out = static_cast<BandId>(i);
      return true;
    }
  }
  return false;
}

// The LR2021 switches to the high-frequency RF path (and the -19..+12 dBm PA)
// above ~1 GHz. Mirrored here so the app can clamp power before a band change.
inline bool isHighFreq(float mhz) { return mhz > 1090.0f; }

inline int8_t clampPower(float mhz, int8_t dbm) {
  const int8_t lo = isHighFreq(mhz) ? -19 : -9;
  const int8_t hi = isHighFreq(mhz) ? 12 : 22;
  if (dbm < lo) return lo;
  if (dbm > hi) return hi;
  return dbm;
}

// ---------------------------------------------------------------------------
// Rede de casamento sub-GHz do módulo
//
// O LoRa2021 traz uma matriz de solda (150 / 433 / 470 / 868 / 915) que escolhe
// a rede de casamento da porta ANT. É seleção FÍSICA: o firmware não pode
// mudá-la, só saber qual está fechada — e avisar quando a frequência sintonizada
// não corresponde. Fora da faixa casada o rádio transmite, mas com VSWR alto:
// alcance ruim e estresse no PA.
//
// A porta 2.4G/S_ANT tem casamento próprio e não depende dessa matriz.
// ---------------------------------------------------------------------------

// Faixas EXATAS de cada posição, do datasheet LoRa2021 V1.3 (seção 4,
// "Frequency Range"). Antes eu usava uma tolerância simétrica chutada, que
// errava justamente onde importa: a posição 470 cobre 470-510, ou seja o
// rótulo é a BORDA INFERIOR da faixa, não o centro.
struct MatchRange {
  uint16_t label;
  float lo, hi;
};

static const MatchRange kMatchOptions[] = {
    {150, 150.0f, 400.0f},   // posição personalizável (150~960 no chip)
    {433, 400.0f, 460.0f},
    {470, 470.0f, 510.0f},
    {868, 850.0f, 890.0f},
    {915, 900.0f, 940.0f},
};
static constexpr uint8_t kMatchCount = sizeof(kMatchOptions) / sizeof(*kMatchOptions);

inline bool isMatchOption(uint16_t mhz) {
  for (uint8_t i = 0; i < kMatchCount; i++) {
    if (kMatchOptions[i].label == mhz) return true;
  }
  return false;
}

// true = a frequência está fora da faixa casada. Só vale para sub-GHz: a porta
// 2.4G/S tem casamento próprio e não depende da matriz.
inline bool isMismatched(uint16_t matched, float mhz) {
  if (isHighFreq(mhz)) return false;
  for (uint8_t i = 0; i < kMatchCount; i++) {
    if (kMatchOptions[i].label == matched) {
      return mhz < kMatchOptions[i].lo || mhz > kMatchOptions[i].hi;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Par de teste — o que está do outro lado do enlace
//
// Este firmware é a BANCADA: LoRa cru, sync 0x12, quadros de texto próprios.
// Ele conversa com outra placa igual, e NÃO decodifica ExpressLRS (que usa
// pacotes OTA de 8 bytes, CRC semeado pelo UID e salto entre 80 canais).
//
// Ainda assim vale escolher um par ELRS: o rádio é posto na camada física
// EXATA do transmissor (implícito + CRC de hardware off + IQ invertido, igual
// ao que o IHM faz), e cada pacote chega como 8 bytes crus no registro. Ver os
// bytes é a prova de que o transmissor é audível. Decodificar de verdade é o
// firmware ExpressLRS (elrs/v3-lr2021).
// ---------------------------------------------------------------------------

// Os valores são gravados na NVS, então NOVOS pares entram no FIM: inserir no
// meio mudaria o significado do que já está salvo nas placas.
enum PeerId : uint8_t {
  PEER_BENCH = 0,
  PEER_ELRS_2G4,
  PEER_ELRS_900,
  PEER_BENCH_2G4,
  PEER_BENCH_433,
  PEER_COUNT
};

struct PeerProfile {
  const char* id;
  const char* name;
  bool decodes;          // false = só escuta, não decodifica
  float frequencyMHz;
  float bandwidthKHz;
  uint8_t spreadingFactor;
  uint8_t codingRate;
  // Camada física do ELRS, copiada do que o IHM faz (SX1280.cpp:183 e
  // SetPacketParamsLoRa). Sem isso a escuta não vê NADA — nem erro de CRC:
  //   - cabeçalho IMPLÍCITO com comprimento fixo (payloadLen)
  //   - CRC de hardware DESLIGADO (o ELRS valida no software, CRC14/16)
  //   - IQ invertido conforme UID[5] & 1
  // payloadLen 0 = par normal (cabeçalho explícito, CRC ligado).
  uint8_t payloadLen;
  uint8_t preambleLen;
  // Potência de transmissão do par, em dBm.
  //
  // Precisa vir do perfil, não ser herdada. Os dois amplificadores do LR2021
  // têm tetos muito diferentes — +22 dBm no sub-GHz contra +12 dBm no 2.4 GHz —
  // e sem este campo trocar de 2.4 GHz para 433 mantinha os 12 dBm anteriores,
  // porque estão dentro da faixa do PA de baixa. O teste de 433 rodaria com
  // 10 dB a menos do que o rádio consegue, o que é um fator ~3 em distância:
  // a comparação entre bandas sairia enviesada e ninguém veria por quê.
  int8_t powerDbm;
  // Taxa de código com interleaver LONGO (CR_LI_4_x).
  //
  // O ExpressLRS usa LI em todas as taxas de 2.4 GHz — a tabela em
  // elrs/ExpressLRS-v3/src/src/common.cpp traz SX1280_LORA_CR_LI_4_8 em todas
  // as linhas de LoRa. Curto e longo são codificações diferentes; escutar com o
  // errado não demodula nada, e a tela fica igual a "não há nada no ar".
  bool longInterleaver;
  const char* note;
};

// As taxas ELRS vêm da tabela do LR1121 na 3.6.4 (índices 9 e 3), que é a mesma
// modulação que o SX1280/SX127x usa nesses modos.
static const PeerProfile kPeerProfiles[PEER_COUNT] = {
    {"bancada", "Outra placa LoRa2021", true, 915.0f, 125.0f, 9, 7, 0, 8, 20, false,
     "Par igual a este firmware: decodifica e faz ping-pong."},
    // 2441,4 MHz é o CANAL DE SYNC do ELRS em 2.4 GHz, não um canal de salto
    // qualquer: banda 2400,4-2479,4 em 80 canais, sync = (80/2)+1 = 41.
    // O transmissor passa por ele com regularidade, então a chance de ouvir
    // algo é muito maior do que sentando num canal arbitrário.
    {"elrs2g4", "Transmissor ExpressLRS 2.4 GHz", false, 2441.4f, 812.5f, 8, 8, 8, 12, 12, true,
     "Canal de sync do ELRS 2.4 GHz (2441,4 MHz). Antena na porta 2.4G. "
     "Mostra os 8 bytes crus de cada pacote no registro."},
    // AU915: 915,5-926,9 em 20 canais -> sync = 11 -> 915,5 + 11*0,6 = 922,1
    {"elrs900", "Transmissor ExpressLRS 900 MHz", false, 922.1f, 500.0f, 8, 7, 8, 10, 20, true,
     "Canal de sync do ELRS AU915 (922,1 MHz). Mostra os 8 bytes crus de cada "
     "pacote no registro."},
    // Par para o TESTE DE ALCANCE em 2.4 GHz. É a outra placa LoRa2021, mas na
    // mesma frequência e na mesma modulação que o ExpressLRS 2.4 GHz usa — 812,5
    // kHz / SF8 / CR4:8, do índice 9 da tabela do LR1121. A ideia é que o
    // alcance medido aqui seja comparável ao de um enlace ELRS de verdade, em
    // vez de um número solto.
    //
    // Diferente do par "elrs2g4", este decodifica: payloadLen 0 mantém cabeçalho
    // explícito e CRC de hardware, que é o protocolo de texto deste firmware.
    // Sem isso as duas placas não conversariam — só se escutariam.
    {"bancada2g4", "Outra placa LoRa2021 em 2.4 GHz", true, 2441.4f, 812.5f, 8, 8, 0, 12, 12, false,
     "Alcance em 2.4 GHz, na PHY do ELRS. ANTENA NA PORTA 2.4G (pino 10)."},
    // Par sub-GHz para os módulos ATUAIS, cuja matriz de solda está fechada em
    // 433 MHz. Com esses módulos, os pares "bancada" (915) e "elrs900" (922,1)
    // não rendem: fora da rede de casamento o sinal quase não sai da antena e o
    // PA transmite contra um descasamento — perde alcance e maltrata o módulo.
    // Eles continuam na lista de propósito, pra quando houver módulo de 915.
    //
    // ATENÇÃO ao comparar alcance com o par de 2.4 GHz: as modulações NÃO são
    // as mesmas. Aqui é SF9 / 125 kHz; lá é SF8 / 812,5 kHz, que é a PHY do
    // ExpressLRS. Cada um é a configuração razoável da sua banda, então o que
    // se mede é "qual montagem vai mais longe" — não o efeito puro da
    // frequência. Para isolar a banda, iguale a modulação em runtime nos dois
    // lados: `bw 125`, `sf 9`, `cr 7`.
    {"bancada433", "Outra placa LoRa2021 em 433 MHz", true, 433.0f, 125.0f, 9, 7, 0, 8, 22, false,
     "Alcance em 433 MHz. ANTENA NA PORTA SUB-GHZ (pino 9)."},
};

inline const PeerProfile& peerProfile(PeerId id) {
  return kPeerProfiles[id < PEER_COUNT ? id : PEER_BENCH];
}

inline bool peerFromId(const String& token, PeerId& out) {
  for (uint8_t i = 0; i < PEER_COUNT; i++) {
    if (token.equalsIgnoreCase(kPeerProfiles[i].id)) {
      out = static_cast<PeerId>(i);
      return true;
    }
  }
  return false;
}

// Preset cuja frequência está mais próxima. Serve pra manter o rótulo de banda
// coerente quando só a portadora é mexida — sem isso o painel dizia "915"
// enquanto o rádio estava em 470.
inline BandId nearestBand(float mhz) {
  BandId best = BAND_915;
  float bestDiff = 1e9f;
  for (uint8_t i = 0; i < BAND_COUNT; i++) {
    const float d = fabsf(mhz - kBandProfiles[i].frequencyMHz);
    if (d < bestDiff) {
      bestDiff = d;
      best = static_cast<BandId>(i);
    }
  }
  return best;
}

inline bool isValidFrequency(float mhz) {
  return (mhz >= 150.0f && mhz <= 1090.0f) ||
         (mhz >= 1900.0f && mhz <= 2200.0f) ||
         (mhz >= 2400.0f && mhz <= 2500.0f);
}
