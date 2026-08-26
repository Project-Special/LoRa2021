#pragma once

#include <Arduino.h>

#include "LR2021Chip.h"
#include "board_pins.h"
#include "radio_profile.h"

// Camada fina sobre o LR2021: dona do estado do modem, do latch de interrupção
// e da regra de manter o rádio escutando sempre que não está transmitindo.
//
// O driver embaixo é LR2021Chip, deste repositório, escrito sobre os comandos
// do fabricante. Sem dependências externas.
class LoraLink {
 public:
  // Códigos de erro do enlace. Console, painel e o módulo express já os
  // interpretam, então o conjunto vive aqui, num lugar só.
  static constexpr int16_t ERR_NONE = 0;
  static constexpr int16_t ERR_BUSY = 1;
  static constexpr int16_t ERR_CHIP_NOT_FOUND = -2;
  static constexpr int16_t ERR_INVALID_FREQUENCY = -11;
  static constexpr int16_t ERR_INVALID_OUTPUT_POWER = -12;
  static constexpr int16_t ERR_INVALID_BANDWIDTH = -13;
  static constexpr int16_t ERR_INVALID_SPREADING_FACTOR = -14;
  static constexpr int16_t ERR_INVALID_CODING_RATE = -15;

  struct Packet {
    String text;          // vazio em modo escuta
    uint8_t raw[LR2021Chip::kMaxPayload];
    uint8_t len = 0;
    float rssi;
    float snr;
  };

  struct State {
    BandId band;
    float frequencyMHz;
    float bandwidthKHz;
    uint8_t spreadingFactor;
    uint8_t codingRate;
    int8_t powerDbm;
    uint8_t syncWord;
  };

  bool begin(BandId band, float tcxoVolts = LR2021_TCXO_VOLTAGE);
  bool restart(float tcxoVolts);

  // Tensões que o LR2021 aceita. 0 = sem TCXO (cristal simples).
  static constexpr float kTcxoOptions[] = {0.0f, 1.6f, 1.7f, 1.8f,
                                           2.2f, 2.4f, 2.7f, 3.0f, 3.3f};
  static constexpr uint8_t kTcxoCount = 9;

  float tcxoVolts() const { return tcxoVolts_; }

  // O rádio pode não subir (fiação, TCXO, alimentação) e o firmware segue
  // rodando pra servir o painel. Quem for mexer no driver checa isto antes.
  bool isReady() const { return chip_.isReady(); }

  int16_t applyBand(BandId band);
  int16_t setFrequency(float mhz);
  int16_t setPower(int8_t dbm);
  int16_t setBandwidth(float khz);
  int16_t setSpreadingFactor(uint8_t sf);
  int16_t setCodingRate(uint8_t cr);

  // Aplica frequência + modem num bloco. A ordem interna importa (frequência
  // antes da potência, porque o teto do PA muda com a banda).
  int16_t applyModem(float freqMHz, float bwKHz, uint8_t sf, uint8_t cr);

  // Modo escuta: reproduz a camada física do ExpressLRS. `payloadLen` > 0 fixa
  // o comprimento e DESLIGA o CRC de hardware — é como o ELRS transmite. Com 0
  // volta ao quadro deste firmware.
  // `longInterleaver` escolhe a família de taxa de código. O ExpressLRS usa as
  // variantes LI (CR_LI_4_x) em TODAS as taxas de 2.4 GHz — ver a tabela em
  // elrs/ExpressLRS-v3/src/src/common.cpp. Interleaver curto e longo são
  // codificações diferentes: com o errado o pacote não demodula, e o sintoma é
  // idêntico a não haver transmissor no ar.
  int16_t setSniff(uint8_t payloadLen, uint8_t preambleLen, bool iqInverted,
                   bool longInterleaver = false);
  bool sniffing() const { return sniffLen_ > 0; }

  int16_t send(const String& payload);

  // Transmite bytes crus, sem o quadro de texto da bancada. É o que permite
  // emitir um pacote de outro protocolo — em modo escuta o cabeçalho já é
  // implícito e o CRC de hardware está desligado, então o que sai no ar é
  // exatamente estes bytes.
  int16_t sendRaw(const uint8_t* data, uint8_t len);
  bool poll(Packet& packet);   // true quando um pacote foi decodificado
  bool transmitFinished();     // consome o latch de fim de transmissão
  bool isTransmitting() const { return txPending_; }
  int16_t lastTransmitState() const { return lastTxState_; }
  int16_t lastReceiveState() const { return lastRxState_; }
  int16_t lastInitState() const { return lastInitState_; }
  int16_t lastPowerState() const { return lastPowerState_; }
  uint32_t receiveErrors() const { return rxErrors_; }

  // Transmissões fechadas por watchdog em vez de por interrupção. Zero é o
  // esperado; crescendo, há IRQ se perdendo.
  uint32_t transmitTimeouts() const { return txTimeouts_; }

  // Piso de ruído do canal, em dBm. Ver LR2021Chip::rssiInstant().
  float noiseFloor() { return chip_.isReady() ? chip_.rssiInstant() : 0.0f; }

  int16_t listen();
  uint32_t timeOnAirMs(size_t payloadLen);

  // Tamanho do quadro no ar. Quem agenda transmissões precisa dele pra saber
  // quanto tempo cada uma ocupa.
  static constexpr uint8_t frameLen() { return kFrameLen; }

  const State& state() const { return state_; }
  static const char* errorName(int16_t code);

 private:
  int16_t resumeRx_();
  int16_t applyPacketParams_();
  bool applyAll_();

  static uint8_t bandwidthCode_(float khz);
  static uint8_t codingRateCode_(uint8_t cr, bool longInterleaver);
  static float bandwidthKhz_(uint8_t code);

  static void IRAM_ATTR onDio_();
  static volatile bool irqFlag_;

  LR2021Chip chip_;

  State state_{};
  volatile bool txPending_ = false;
  uint32_t txStartedAt_ = 0;
  uint32_t txTimeoutMs_ = 0;
  uint32_t txTimeouts_ = 0;
  int16_t lastTxState_ = ERR_NONE;
  int16_t lastRxState_ = ERR_NONE;
  int16_t lastInitState_ = ERR_NONE;
  int16_t lastPowerState_ = ERR_NONE;
  uint32_t rxErrors_ = 0;
  bool txDoneLatched_ = false;
  uint8_t sniffLen_ = 0;
  uint16_t preambleLen_ = 8;
  bool iqInverted_ = false;
  bool longInterleaver_ = false;
  float tcxoVolts_ = LR2021_TCXO_VOLTAGE;
  BandId band_ = BAND_915;

  // Comprimento do quadro no ar quando não estamos em modo escuta.
  //
  // O cabeçalho é IMPLÍCITO, como no driver do fabricante: o receptor não
  // aprende o tamanho pelo ar, então todo quadro tem o mesmo e o resto vai
  // zerado. Custa alguns bytes de ar e devolve duas coisas — tempo no ar
  // constante, que é o que se quer ao medir alcance, e um caminho de RX igual
  // ao que o ExpressLRS exercita todo dia.
  static constexpr uint8_t kFrameLen = 48;
};
