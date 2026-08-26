#include "LR2021Chip.h"

#include "lr2021_pram.h"

namespace {

// Endereço da RAM de patch, do driver da Semtech.
constexpr uint32_t kPramBase = 0x801000;

// O patch é gravado em blocos de 12 palavras de 32 bits — o mesmo tamanho que o
// driver de referência usa. Blocos maiores estouram o buffer de comando do chip.
constexpr uint8_t kPramChunk = 12;

// Versão de firmware que um LR2021 são responde ao GET_VERSION.
constexpr uint8_t kFwMajor = 0x01;
constexpr uint8_t kFwMinor = 0x18;

}  // namespace

// -----------------------------------------------------------------------------
// Camada SPI
// -----------------------------------------------------------------------------

bool LR2021Chip::waitBusy(uint32_t timeoutUs) {
  const uint32_t start = micros();
  while (digitalRead(pins_.busy)) {
    if (micros() - start > timeoutUs) return false;
  }
  return true;
}

uint16_t LR2021Chip::command(uint16_t opcode, const uint8_t* data, uint8_t len) {
  waitBusy();
  SPI.beginTransaction(spi_);
  digitalWrite(pins_.nss, LOW);
  const uint8_t s0 = SPI.transfer(opcode >> 8);
  const uint8_t s1 = SPI.transfer(opcode & 0xFF);
  for (uint8_t i = 0; i < len; ++i) SPI.transfer(data[i]);
  digitalWrite(pins_.nss, HIGH);
  SPI.endTransaction();
  lastStatus_ = (static_cast<uint16_t>(s0) << 8) | s1;
  return lastStatus_;
}

uint16_t LR2021Chip::response(uint8_t* buf, uint8_t len) {
  waitBusy();
  SPI.beginTransaction(spi_);
  digitalWrite(pins_.nss, LOW);
  for (uint8_t i = 0; i < len; ++i) buf[i] = SPI.transfer(buf[i]);
  digitalWrite(pins_.nss, HIGH);
  SPI.endTransaction();
  lastStatus_ = (static_cast<uint16_t>(buf[0]) << 8) | buf[1];
  return lastStatus_;
}

// -----------------------------------------------------------------------------
// Inicialização
// -----------------------------------------------------------------------------

void LR2021Chip::hardReset() {
  pinMode(pins_.rst, OUTPUT);
  digitalWrite(pins_.rst, LOW);
  delay(10);
  digitalWrite(pins_.rst, HIGH);
  // O LR2021 mantém o BUSY alto por ~230 ms depois do reset, fazendo o boot
  // interno. Falar SPI antes disso devolve zeros e parece chip ausente.
  delay(300);
  waitBusy(500000);
}

bool LR2021Chip::checkVersion() {
  command(LR2021_SYSTEM_GET_VERSION_OC);
  uint8_t buf[4] = {0};
  response(buf, sizeof(buf));
  return buf[2] == kFwMajor && buf[3] == kFwMinor;
}

bool LR2021Chip::writeRegMem32(uint32_t address, const uint32_t* words,
                               uint8_t count) {
  uint8_t buf[4 + kPramChunk * 4];
  buf[0] = address >> 24;
  buf[1] = address >> 16;
  buf[2] = address >> 8;
  buf[3] = address;
  for (uint8_t i = 0; i < count; ++i) {
    const uint32_t w = words[i];
    buf[4 + i * 4 + 0] = w >> 24;
    buf[4 + i * 4 + 1] = w >> 16;
    buf[4 + i * 4 + 2] = w >> 8;
    buf[4 + i * 4 + 3] = w;
  }
  command(LR2021_REGMEM_WRITE_REGMEM32_OC, buf, 4 + count * 4);
  return true;
}

bool LR2021Chip::loadPatchRam() {
  // O LR2021 sai de fábrica sem parte do firmware de rádio; ele vive num patch
  // que o host grava na PRAM a cada boot. Sem isto o chip responde a comandos
  // mas não modula nada.
  constexpr uint32_t kWords = sizeof(pram_lr2021) / sizeof(uint32_t);
  constexpr uint32_t kChunks = kWords / kPramChunk;

  for (uint32_t i = 0; i < kChunks; ++i) {
    if (!writeRegMem32(kPramBase + i * kPramChunk * sizeof(uint32_t),
                       pram_lr2021 + i * kPramChunk, kPramChunk)) {
      return false;
    }
  }
  constexpr uint8_t kRest = kWords - kChunks * kPramChunk;
  if (kRest > 0) {
    if (!writeRegMem32(kPramBase + kChunks * kPramChunk * sizeof(uint32_t),
                       pram_lr2021 + kChunks * kPramChunk, kRest)) {
      return false;
    }
  }

  constexpr uint8_t enable = 0x01;
  command(LR2021_PATCH_ENABLE_PRAM_OC, &enable, 1);
  return waitBusy(50000);
}

bool LR2021Chip::begin(const Pins& pins, float tcxoVolts, uint32_t lowHz,
                       uint32_t highHz) {
  pins_ = pins;
  ready_ = false;

  pinMode(pins_.nss, OUTPUT);
  digitalWrite(pins_.nss, HIGH);
  pinMode(pins_.busy, INPUT);
  pinMode(pins_.irq, INPUT);
  SPI.begin(pins_.sck, pins_.miso, pins_.mosi, pins_.nss);

  hardReset();
  if (!checkVersion()) return false;
  if (!loadPatchRam()) return false;

  command(LR2021_SYSTEM_CLEAR_ERRORS_OC);

  // 2.1.2.1 SetStandby (RC)
  const uint8_t stby = 0x00;
  command(LR2021_SYSTEM_SET_STANDBY_OC, &stby, 1);

  // 2.1.6.1 SetTcxoMode. Este módulo sai com cristal; com tensão de TCXO
  // configurada sem TCXO presente, a calibração falha com device error 0x2081.
  if (tcxoVolts > 0.0f) {
    const uint8_t reg = tcxoVolts >= 3.3f   ? 0x07
                        : tcxoVolts >= 3.0f ? 0x06
                        : tcxoVolts >= 2.7f ? 0x05
                        : tcxoVolts >= 2.4f ? 0x04
                        : tcxoVolts >= 2.2f ? 0x03
                        : tcxoVolts >= 1.8f ? 0x02
                        : tcxoVolts >= 1.7f ? 0x01
                                            : 0x00;
    // Espera de arranque do oscilador, em passos de 30,52 us.
    const uint32_t delayTicks = 300;
    const uint8_t buf[] = {reg, static_cast<uint8_t>(delayTicks >> 24),
                           static_cast<uint8_t>(delayTicks >> 16),
                           static_cast<uint8_t>(delayTicks >> 8),
                           static_cast<uint8_t>(delayTicks)};
    command(LR2021_SYSTEM_SET_TCXO_MODE_OC, buf, sizeof(buf));
  }

  // 6.3.7 SetRxTxFallbackMode — O PONTO DA HISTÓRIA. Ver o cabeçalho.
  const uint8_t fallback = LR2021_RADIO_FALLBACK_FS;
  command(LR2021_RADIO_SET_RX_TX_FALLBACK_MODE_OC, &fallback, 1);

  // 6.3.17 SetDefaultRxTxTimeout: RX contínuo, TX sem timeout.
  const uint8_t timeouts[] = {0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00};
  command(LR2021_RADIO_SET_DEFAULT_RX_TX_TIMEOUT_OC, timeouts, sizeof(timeouts));

  // 6.3.18 SetRegMode: 0x00 = LDO. Este módulo não traz o indutor do DC-DC.
  const uint8_t regMode = 0x00;
  command(LR2021_SYSTEM_SET_REGMODE_OC, &regMode, 1);

  // 6.4.2 Calibrate (todos os blocos) e CalibFE (front-end, por faixa).
  const uint8_t calibrate = 0x7F;
  command(LR2021_SYSTEM_CALIBRATE_OC, &calibrate, 1);
  if (!waitBusy(200000)) return false;

  const uint16_t lo = lowHz / 4000000UL;
  const uint16_t hi = highHz / 4000000UL;
  const uint8_t calibFE[] = {
      static_cast<uint8_t>(lo >> 8), static_cast<uint8_t>(lo),
      static_cast<uint8_t>((hi >> 8) | 0x80), static_cast<uint8_t>(hi)};
  command(LR2021_SYSTEM_CALIBRATE_FRONTEND_OC, calibFE, sizeof(calibFE));
  if (!waitBusy(500000)) return false;

  // 4.2.1 SetDioFunction: o DIO só vira linha de interrupção depois de ser
  // DECLARADO como tal. Sem este passo ele fica em alta impedância, o chip
  // funciona por completo — inicializa, transmite, recebe — e nenhuma
  // interrupção chega ao MCU. 0x10 = função IRQ, sem pull no sleep.
  const uint8_t dioFunc[] = {LR2021_IRQ_DIO_NUM, 0x10};
  command(LR2021_SYSTEM_SET_DIO_FUNCTION_OC, dioFunc, sizeof(dioFunc));

  // 4.1.1 SetDioIrqParams: só RX_DONE e TX_DONE, no DIO escolhido pela placa.
  const uint32_t irqs = LR2021_IRQ_RX_DONE | LR2021_IRQ_TX_DONE;
  const uint8_t irqCfg[] = {LR2021_IRQ_DIO_NUM,
                            static_cast<uint8_t>(irqs >> 24),
                            static_cast<uint8_t>(irqs >> 16),
                            static_cast<uint8_t>(irqs >> 8),
                            static_cast<uint8_t>(irqs)};
  command(LR2021_SYSTEM_SET_DIOIRQPARAMS_OC, irqCfg, sizeof(irqCfg));

  clearIrq();
  ready_ = true;
  return true;
}

// -----------------------------------------------------------------------------
// Configuração de rádio
// -----------------------------------------------------------------------------

bool LR2021Chip::setFrequency(uint32_t freqHz) {
  const uint8_t buf[] = {
      static_cast<uint8_t>(freqHz >> 24), static_cast<uint8_t>(freqHz >> 16),
      static_cast<uint8_t>(freqHz >> 8), static_cast<uint8_t>(freqHz)};
  command(LR2021_RADIO_SET_RF_FREQUENCY_OC, buf, sizeof(buf));
  freqHz_ = freqHz;
  return true;
}

bool LR2021Chip::setSyncWord(uint8_t sync) {
  // 8.3.4 SetLoRaSyncWord
  command(0x0223, &sync, 1);
  return true;
}

bool LR2021Chip::setRxPath() {
  // 7.2.2 SetRxPath: o LR2021 tem entradas de RF separadas por banda, e a
  // escolha é explícita — não há chave automática.
  if (subGhz()) {
    const uint8_t buf[] = {0x00, 0x00};
    command(LR2021_RADIO_SET_RX_PATH_OC, buf, sizeof(buf));
  } else {
    const uint8_t buf[] = {0x01, 0x04};
    command(LR2021_RADIO_SET_RX_PATH_OC, buf, sizeof(buf));
  }
  return true;
}

bool LR2021Chip::setPaConfig() {
  // 7.3.1 SetPaConfig. Os dois amplificadores têm parâmetros próprios; usar o
  // do outro lado custa potência e linearidade.
  if (subGhz()) {
    const uint8_t buf[] = {LR2021_RADIO_PA_SEL_LF, 7 << 4 | 6, 16};
    command(LR2021_RADIO_SET_PA_CFG_OC, buf, sizeof(buf));
  } else {
    const uint8_t buf[] = {LR2021_RADIO_PA_SEL_HF, 6 << 4 | 7, 30};
    command(LR2021_RADIO_SET_PA_CFG_OC, buf, sizeof(buf));
  }
  return true;
}

bool LR2021Chip::setPower(int8_t dbm) {
  // 9.5.2 SetTxParams. A potência vai em passos de 0,5 dBm, e os limites são
  // por amplificador: -9..+22 dBm no sub-GHz, -19..+12 dBm no 2.4 GHz.
  const int8_t lo = subGhz() ? -9 : -19;
  const int8_t hi = subGhz() ? 22 : 12;
  if (dbm < lo) dbm = lo;
  if (dbm > hi) dbm = hi;
  powerDbm_ = dbm;

  const uint8_t buf[] = {static_cast<uint8_t>(dbm * 2), LR2021_RADIO_RAMP_48_US};
  command(LR2021_RADIO_SET_TX_PARAMS_OC, buf, sizeof(buf));
  return true;
}

bool LR2021Chip::configLoRa(uint32_t freqHz, uint8_t bw, uint8_t sf, uint8_t cr,
                            uint16_t preambleLen, uint8_t payloadLen,
                            bool implicitHeader, bool crcOn, bool iqInverted) {
  if (!ready_) return false;
  if (payloadLen > kMaxPayload) payloadLen = kMaxPayload;
  payloadLen_ = payloadLen;

  standby();

  // 8.1.1 SetPacketType
  const uint8_t pktType = LR2021_RADIO_PKT_TYPE_LORA;
  command(LR2021_RADIO_SET_PKT_TYPE_OC, &pktType, 1);

  // 8.3.1 SetLoRaModulationParams
  const uint8_t mod[] = {static_cast<uint8_t>(sf << 4 | bw),
                         static_cast<uint8_t>(cr << 4)};
  command(LR2021_RADIO_SET_LORA_MODULATION_PARAM_OC, mod, sizeof(mod));

  // 8.3.2 SetLoRaPacketParams. O último byte junta três campos:
  //   bit 2 = cabeçalho (0 explícito, 1 implícito)
  //   bit 1 = CRC de hardware
  //   bit 0 = inversão de IQ
  const uint8_t flags = static_cast<uint8_t>((implicitHeader ? 1 : 0) << 2 |
                                             (crcOn ? 1 : 0) << 1 |
                                             (iqInverted ? 1 : 0));
  const uint8_t pkt[] = {static_cast<uint8_t>(preambleLen >> 8),
                         static_cast<uint8_t>(preambleLen), payloadLen, flags};
  command(LR2021_RADIO_SET_LORA_PACKET_PARAMS_OC, pkt, sizeof(pkt));

  setFrequency(freqHz);
  setRxPath();
  setPaConfig();
  setPower(powerDbm_);

  clearIrq();
  command(LR2021_SYSTEM_CLEAR_RX_FIFO_OC);
  command(LR2021_SYSTEM_CLEAR_TX_FIFO_OC);
  return true;
}

// -----------------------------------------------------------------------------
// Operação
// -----------------------------------------------------------------------------

bool LR2021Chip::standby() {
  const uint8_t stby = 0x00;
  command(LR2021_SYSTEM_SET_STANDBY_OC, &stby, 1);
  return true;
}

bool LR2021Chip::startTx(const uint8_t* data, uint8_t len) {
  if (!ready_) return false;
  // Cabeçalho implícito: o receptor não é informado do comprimento, então todo
  // quadro tem o mesmo tamanho e o resto vai zerado. De quebra, o tempo no ar
  // fica constante — o que é melhor pra medir alcance.
  uint8_t buf[kMaxPayload] = {0};
  const uint8_t n = len > payloadLen_ ? payloadLen_ : len;
  memcpy(buf, data, n);

  command(LR2021_SYSTEM_CLEAR_TX_FIFO_OC);
  command(LR2021_RADIO_WRITE_TX_FIFO, buf, payloadLen_);
  command(LR2021_RADIO_SET_TX_OC);
  return true;
}

bool LR2021Chip::startRx() {
  if (!ready_) return false;
  command(LR2021_SYSTEM_CLEAR_RX_FIFO_OC);
  command(LR2021_RADIO_SET_RX_OC);
  return true;
}

uint32_t LR2021Chip::irqStatus() {
  // O opcode de limpeza também serve de leitura: a transação devolve a máscara
  // pendente nos bytes 2..5. É como o driver do fabricante lê o status.
  uint8_t buf[6] = {LR2021_SYSTEM_CLEAR_IRQ_OC >> 8,
                    LR2021_SYSTEM_CLEAR_IRQ_OC & 0xFF, 0, 0, 0, 0};
  response(buf, sizeof(buf));
  return (static_cast<uint32_t>(buf[2]) << 24) |
         (static_cast<uint32_t>(buf[3]) << 16) |
         (static_cast<uint32_t>(buf[4]) << 8) | buf[5];
}

void LR2021Chip::clearIrq() {
  const uint8_t all[] = {0xFF, 0xFF, 0xFF, 0xFF};
  command(LR2021_SYSTEM_CLEAR_IRQ_OC, all, sizeof(all));
}

bool LR2021Chip::readPacket(uint8_t* out, uint8_t len) {
  if (len > payloadLen_) len = payloadLen_;
  uint8_t buf[kMaxPayload + 2] = {LR2021_RADIO_READ_RX_FIFO >> 8,
                                  LR2021_RADIO_READ_RX_FIFO & 0xFF};
  response(buf, len + 2);
  memcpy(out, buf + 2, len);
  command(LR2021_SYSTEM_CLEAR_RX_FIFO_OC);
  return true;
}

float LR2021Chip::rssiInstant() {
  // 7.2.8 GetRssiInst. O valor volta negado, em passos de 0,5 dB: o byte 2 é a
  // parte inteira e o bit alto do byte 3 é o meio dB.
  command(LR2021_RADIO_GET_RSSI_INST_OC);
  uint8_t buf[4] = {0};
  response(buf, sizeof(buf));
  return -(static_cast<float>(buf[2]) + ((buf[3] & 0x80) ? 0.5f : 0.0f));
}

LR2021Chip::PacketStatus LR2021Chip::packetStatus() {
  command(LR2021_RADIO_GET_LORA_PACKET_STATUS_OC);
  uint8_t buf[8] = {0};
  response(buf, sizeof(buf));
  PacketStatus s;
  // Índices conforme o driver de referência: o RSSI vem negado em buf[6], e o
  // SNR em buf[4] é com sinal, em quartos de dB.
  s.rssi = -static_cast<float>(buf[6]);
  s.snr = static_cast<float>(static_cast<int8_t>(buf[4])) / 4.0f;
  return s;
}
