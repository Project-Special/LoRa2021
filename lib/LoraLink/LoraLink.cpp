#include "LoraLink.h"

volatile bool LoraLink::irqFlag_ = false;

void IRAM_ATTR LoraLink::onDio_() { irqFlag_ = true; }

constexpr float LoraLink::kTcxoOptions[];

namespace {

// Silêncio total (nem TX concluído, nem pacote lido) que faz o watchdog rearmar
// a escuta. Folgado de propósito: num enlace a 4 Hz, 3 s são 12 quadros — já é
// anormal — e o prazo longo evita abortar recepção em curso à toa.
constexpr uint32_t kRxWatchdogMs = 3000;

}  // namespace

// Tabela de largura de banda do LR2021. Os códigos são do fabricante e NÃO são
// sequenciais: 101/203/406/812 kHz ficam no fim da faixa de valores, fora da
// ordem das larguras clássicas.
struct BwEntry {
  float khz;
  uint8_t code;
};

static const BwEntry kBandwidths[] = {
    {31.25f, 0x02},  {41.67f, 0x0A}, {62.5f, 0x03},  {83.34f, 0x0B},
    {101.0f, 0x0C},  {125.0f, 0x04}, {203.125f, 0x0D}, {250.0f, 0x05},
    {406.25f, 0x0E}, {500.0f, 0x06}, {812.5f, 0x0F}, {1000.0f, 0x07},
};
static constexpr uint8_t kBandwidthCount =
    sizeof(kBandwidths) / sizeof(*kBandwidths);

uint8_t LoraLink::bandwidthCode_(float khz) {
  // Escolhe a largura mais próxima em vez de exigir valor exato: o console
  // aceita "812" e "812.5", e o painel manda float.
  uint8_t best = 0x04;  // 125 kHz
  float bestDiff = 1e9f;
  for (uint8_t i = 0; i < kBandwidthCount; ++i) {
    const float d = fabsf(khz - kBandwidths[i].khz);
    if (d < bestDiff) {
      bestDiff = d;
      best = kBandwidths[i].code;
    }
  }
  return best;
}

uint8_t LoraLink::codingRateCode_(uint8_t cr, bool longInterleaver) {
  if (!longInterleaver) return cr - 4;  // 5->0x01 .. 8->0x04
  // A família LI não tem 4/7: o LR2021 só define LI 4/5, 4/6 e 4/8.
  switch (cr) {
    case 5: return LR2021_RADIO_LORA_CR_LI_4_5;
    case 6: return LR2021_RADIO_LORA_CR_LI_4_6;
    default: return LR2021_RADIO_LORA_CR_LI_4_8;
  }
}

float LoraLink::bandwidthKhz_(uint8_t code) {
  for (uint8_t i = 0; i < kBandwidthCount; ++i) {
    if (kBandwidths[i].code == code) return kBandwidths[i].khz;
  }
  return 125.0f;
}

bool LoraLink::begin(BandId band, float tcxoVolts) {
  band_ = band;
  tcxoVolts_ = tcxoVolts;

  const LR2021Chip::Pins pins{PIN_LORA_SCK,  PIN_LORA_MISO, PIN_LORA_MOSI,
                              PIN_LORA_NSS,  PIN_LORA_RST,  PIN_LORA_BUSY,
                              PIN_LORA_IRQ};

  // As duas faixas a calibrar no front-end. Cobrem tudo que os perfis usam: a
  // matriz sub-GHz deste módulo e a porta de 2.4 GHz.
  if (!chip_.begin(pins, tcxoVolts_, 400000000UL, 2500000000UL)) {
    lastInitState_ = ERR_CHIP_NOT_FOUND;
    return false;
  }

  const BandProfile& profile = bandProfile(band);
  state_.band = band;
  state_.frequencyMHz = profile.frequencyMHz;
  state_.bandwidthKHz = profile.bandwidthKHz;
  state_.spreadingFactor = profile.spreadingFactor;
  state_.codingRate = profile.codingRate;
  state_.powerDbm = profile.powerDbm;
  state_.syncWord = profile.syncWord;

  if (!applyAll_()) {
    lastInitState_ = ERR_CHIP_NOT_FOUND;
    return false;
  }

  attachInterrupt(digitalPinToInterrupt(PIN_LORA_IRQ), onDio_, RISING);
  lastInitState_ = ERR_NONE;
  resumeRx_();
  return true;
}

bool LoraLink::restart(float tcxoVolts) {
  detachInterrupt(digitalPinToInterrupt(PIN_LORA_IRQ));
  txPending_ = false;
  txDoneLatched_ = false;
  return begin(band_, tcxoVolts);
}

bool LoraLink::applyAll_() {
  const uint32_t freqHz =
      static_cast<uint32_t>(state_.frequencyMHz * 1000000.0f + 0.5f);

  // Em modo escuta o comprimento e o CRC vêm do ELRS; fora dele, o quadro é o
  // nosso, de tamanho fixo e com CRC de hardware ligado.
  const bool sniff = sniffLen_ > 0;
  const uint8_t payload = sniff ? sniffLen_ : kFrameLen;

  chip_.setPower(state_.powerDbm);
  const bool ok = chip_.configLoRa(
      freqHz, bandwidthCode_(state_.bandwidthKHz), state_.spreadingFactor,
      codingRateCode_(state_.codingRate, longInterleaver_), preambleLen_, payload,
      /*implicitHeader=*/true, /*crcOn=*/!sniff, iqInverted_ && sniff);
  if (!ok) return false;
  chip_.setSyncWord(state_.syncWord);
  chip_.setPower(state_.powerDbm);
  return true;
}

int16_t LoraLink::applyBand(BandId band) {
  if (band >= BAND_COUNT) return ERR_INVALID_FREQUENCY;
  band_ = band;
  const BandProfile& p = bandProfile(band);
  state_.band = band;
  state_.frequencyMHz = p.frequencyMHz;
  state_.bandwidthKHz = p.bandwidthKHz;
  state_.spreadingFactor = p.spreadingFactor;
  state_.codingRate = p.codingRate;
  state_.powerDbm = p.powerDbm;
  state_.syncWord = p.syncWord;
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::setFrequency(float mhz) {
  const bool ok = (mhz >= 150.0f && mhz <= 1090.0f) ||
                  (mhz >= 1900.0f && mhz <= 2200.0f) ||
                  (mhz >= 2400.0f && mhz <= 2500.0f);
  if (!ok) return ERR_INVALID_FREQUENCY;
  state_.frequencyMHz = mhz;
  state_.band = nearestBand(mhz);
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::setPower(int8_t dbm) {
  state_.powerDbm = clampPower(state_.frequencyMHz, dbm);
  chip_.setPower(state_.powerDbm);
  lastPowerState_ = ERR_NONE;
  return ERR_NONE;
}

int16_t LoraLink::setBandwidth(float khz) {
  state_.bandwidthKHz = bandwidthKhz_(bandwidthCode_(khz));
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::setSpreadingFactor(uint8_t sf) {
  if (sf < 5 || sf > 12) return ERR_INVALID_SPREADING_FACTOR;
  state_.spreadingFactor = sf;
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::setCodingRate(uint8_t cr) {
  if (cr < 5 || cr > 8) return ERR_INVALID_CODING_RATE;
  state_.codingRate = cr;
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::applyModem(float freqMHz, float bwKHz, uint8_t sf,
                              uint8_t cr) {
  const bool freqOk = (freqMHz >= 150.0f && freqMHz <= 1090.0f) ||
                      (freqMHz >= 1900.0f && freqMHz <= 2200.0f) ||
                      (freqMHz >= 2400.0f && freqMHz <= 2500.0f);
  if (!freqOk) return ERR_INVALID_FREQUENCY;
  if (sf < 5 || sf > 12) return ERR_INVALID_SPREADING_FACTOR;
  if (cr < 5 || cr > 8) return ERR_INVALID_CODING_RATE;

  state_.frequencyMHz = freqMHz;
  state_.band = nearestBand(freqMHz);
  state_.bandwidthKHz = bandwidthKhz_(bandwidthCode_(bwKHz));
  state_.spreadingFactor = sf;
  state_.codingRate = cr;
  state_.powerDbm = clampPower(freqMHz, state_.powerDbm);
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::setSniff(uint8_t payloadLen, uint8_t preambleLen,
                            bool iqInverted, bool longInterleaver) {
  if (!chip_.isReady()) return ERR_CHIP_NOT_FOUND;
  sniffLen_ = payloadLen;
  preambleLen_ = preambleLen ? preambleLen : 8;
  iqInverted_ = iqInverted;
  longInterleaver_ = longInterleaver;
  if (!applyAll_()) return ERR_CHIP_NOT_FOUND;
  return resumeRx_();
}

int16_t LoraLink::send(const String& payload) {
  if (!chip_.isReady()) return ERR_CHIP_NOT_FOUND;
  if (txPending_) return ERR_BUSY;

  irqFlag_ = false;
  chip_.startTx(reinterpret_cast<const uint8_t*>(payload.c_str()),
                payload.length() + 1);
  txPending_ = true;
  lastTxState_ = ERR_NONE;

  // Prazo pro watchdog de poll(): o dobro do tempo no ar mais uma folga fixa.
  // Proporcional porque SF12 leva quase mil vezes mais tempo que SF5, e um
  // prazo fixo ou seria curto demais lá ou inútil aqui.
  txStartedAt_ = millis();
  txTimeoutMs_ = timeOnAirMs(kFrameLen) * 2 + 50;
  return ERR_NONE;
}

int16_t LoraLink::sendRaw(const uint8_t* data, uint8_t len) {
  if (!chip_.isReady()) return ERR_CHIP_NOT_FOUND;
  if (txPending_) return ERR_BUSY;

  irqFlag_ = false;
  chip_.startTx(data, len);
  txPending_ = true;
  lastTxState_ = ERR_NONE;
  txStartedAt_ = millis();
  txTimeoutMs_ = timeOnAirMs(sniffLen_ > 0 ? sniffLen_ : kFrameLen) * 2 + 50;
  return ERR_NONE;
}

bool LoraLink::poll(Packet& packet) {
  if (!chip_.isReady()) return false;

  // Watchdog de transmissão.
  //
  // Todo o fluxo depende de UMA interrupção pra fechar o TX. Se ela se perde —
  // ruído no DIO9, uma volta de loop demorada — o rádio ficaria em TX pra
  // sempre. E o pior seria o silêncio: quem transmite testa isTransmitting()
  // antes, então nem "TX FAILED" apareceria.
  if (txPending_ && millis() - txStartedAt_ > txTimeoutMs_) {
    txPending_ = false;
    ++txTimeouts_;
    chip_.clearIrq();
    resumeRx_();
    return false;
  }

  if (!irqFlag_) return false;
  irqFlag_ = false;

  const uint32_t irq = chip_.irqStatus();
  chip_.clearIrq();

  if (irq & LR2021_IRQ_TX_DONE) {
    txPending_ = false;
    txDoneLatched_ = true;
    // Não é preciso mandar o rádio de volta pra RX: o fallback do chip está em
    // FS e o startRx daqui só re-arma a escuta, que é barato e determinístico.
    resumeRx_();
    if (!(irq & LR2021_IRQ_RX_DONE)) return false;
  }

  if (!(irq & LR2021_IRQ_RX_DONE)) return false;

  uint8_t buf[LR2021Chip::kMaxPayload] = {0};
  const uint8_t len = sniffLen_ > 0 ? sniffLen_ : kFrameLen;
  chip_.readPacket(buf, len);

  const LR2021Chip::PacketStatus st = chip_.packetStatus();
  packet.rssi = st.rssi;
  packet.snr = st.snr;

  if (sniffLen_ > 0) {
    // Modo escuta: bytes crus, sem CRC de hardware — quem valida é o ELRS.
    packet.len = len > sizeof(packet.raw) ? sizeof(packet.raw) : len;
    memcpy(packet.raw, buf, packet.len);
    packet.text = "";
  } else {
    // Quadro nosso: texto terminado em NUL dentro de um bloco de tamanho fixo.
    // Garantir o terminador antes de construir a String evita ler além do
    // buffer se um quadro corrompido passar pelo CRC.
    buf[sizeof(buf) - 1] = '\0';
    packet.text = String(reinterpret_cast<const char*>(buf));
    packet.len = 0;
    if (packet.text.isEmpty()) {
      rxErrors_++;
      resumeRx_();
      return false;
    }
  }

  lastRxState_ = ERR_NONE;
  resumeRx_();
  return true;
}

bool LoraLink::transmitFinished() {
  if (!txDoneLatched_) return false;
  txDoneLatched_ = false;
  return true;
}

int16_t LoraLink::listen() { return resumeRx_(); }

int16_t LoraLink::resumeRx_() {
  if (!chip_.isReady()) return ERR_CHIP_NOT_FOUND;
  chip_.startRx();
  return ERR_NONE;
}

uint32_t LoraLink::timeOnAirMs(size_t payloadLen) {
  if (!chip_.isReady()) return 0;

  // Tempo no ar de LoRa, do datasheet: símbolo = 2^SF / BW; preâmbulo +
  // 4,25 símbolos; o payload entra por blocos de (4+CR) símbolos.
  const float bwHz = state_.bandwidthKHz * 1000.0f;
  const uint8_t sf = state_.spreadingFactor;
  const float tSym = static_cast<float>(1UL << sf) / bwHz;

  const int de = (tSym > 0.016f) ? 1 : 0;  // low data rate optimize
  const int crcOn = sniffLen_ > 0 ? 0 : 1;
  const int implicitHeader = 1;

  float num = 8.0f * payloadLen - 4.0f * sf + 28.0f + 16.0f * crcOn -
              20.0f * implicitHeader;
  float den = 4.0f * (sf - 2 * de);
  int nPayload = 8;
  if (den > 0) {
    const int blocks = static_cast<int>(ceilf(num / den));
    nPayload += (blocks > 0 ? blocks : 0) * state_.codingRate;
  }

  const float tPreamble = (preambleLen_ + 4.25f) * tSym;
  const float total = tPreamble + nPayload * tSym;
  return static_cast<uint32_t>(total * 1000.0f + 0.5f);
}

const char* LoraLink::errorName(int16_t code) {
  switch (code) {
    case ERR_NONE: return "OK";
    case ERR_BUSY: return "BUSY (TX in progress)";
    case ERR_CHIP_NOT_FOUND: return "CHIP_NOT_FOUND (check SPI/NRST/BUSY)";
    case ERR_INVALID_FREQUENCY: return "INVALID_FREQUENCY";
    case ERR_INVALID_OUTPUT_POWER: return "INVALID_OUTPUT_POWER";
    case ERR_INVALID_BANDWIDTH: return "INVALID_BANDWIDTH";
    case ERR_INVALID_SPREADING_FACTOR: return "INVALID_SPREADING_FACTOR";
    case ERR_INVALID_CODING_RATE: return "INVALID_CODING_RATE";
    default: return "ERRO";
  }
}
