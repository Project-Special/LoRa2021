#pragma once

#include <Arduino.h>
#include <SPI.h>

#include "lr2021_regs.h"

// Qual DIO do módulo vira a linha de interrupção. O LoRa2021 não traz um pino
// "IRQ": expõe DIO7, DIO8 e DIO9 crus, e a escolha é feita por SPI. DIO9 é o
// default do driver da Semtech.
#ifndef LR2021_IRQ_DIO_NUM
#define LR2021_IRQ_DIO_NUM 9
#endif

// Driver do Semtech LR2021 escrito direto sobre os comandos do fabricante.
//
// O MODO DE FALLBACK É O QUE FAZ MEIA-DUPLEX FUNCIONAR
//
// Depois de cada transmissão e de cada recepção, o LR2021 cai num estado de
// repouso escolhido por SetRxTxFallbackMode. A escolha decide se o rádio
// consegue voltar a escutar entre um quadro e o seguinte.
//
// Com STANDBY_RC — o estado mais frio, e o padrão de quem não configura — o
// chip derruba o XOSC ao fim do TX, e voltar pra recepção exige religar o
// oscilador e re-sintonizar o PLL. Medido nesta bancada, em 2.4 GHz a 4 quadros
// por segundo, com o fallback em STANDBY_RC:
//
//   transmissor calado      -> recebe 3 de 3
//   transmissor a 4 Hz      -> recebe 0 de dezenas, com rx_err = 0
//
// O rx_err zerado é a parte que denuncia: o rádio não chegava nem a ouvir
// preâmbulo entre uma transmissão e a seguinte. E meia-duplex é justamente o
// que um enlace de RC faz o tempo todo.
//
// Por isso aqui o fallback é FALLBACK_FS, igual ao driver do ExpressLRS: o chip
// cai em síntese de frequência, quente e já na frequência certa, e volta pra RX
// em microssegundos.
//
// FONTES
//
// Os opcodes e os campos vêm de lr2021_regs.h, que é o lr20xx_radio_types.h da
// Semtech (Clear BSD, copyright Semtech 2021), e o patch de PRAM em
// lr2021_pram.h é o binário distribuído pela Semtech. A sequência de
// inicialização segue a numeração do datasheet, citada em cada passo.
class LR2021Chip {
 public:
  struct Pins {
    uint8_t sck, miso, mosi, nss, rst, busy, irq;
  };

  struct PacketStatus {
    float rssi;   // dBm
    float snr;    // dB
  };

  // Maior payload que este driver movimenta. O chip aceita mais; o limite aqui
  // é o do buffer estático, dimensionado pro protocolo da bancada.
  static constexpr uint8_t kMaxPayload = 64;

  // lowHz / highHz delimitam as bandas a calibrar no front-end. O LR2021 tem
  // dois caminhos de RF e a calibração é por faixa, então os dois valores
  // precisam cobrir onde o rádio vai realmente operar.
  bool begin(const Pins& pins, float tcxoVolts, uint32_t lowHz, uint32_t highHz);

  bool isReady() const { return ready_; }
  uint16_t lastStatus() const { return lastStatus_; }

  // Configura a camada física inteira num bloco. A ordem importa (tipo de
  // pacote, modulação, pacote, frequência, caminho de RX, PA, potência), e é a
  // mesma do driver de referência.
  bool configLoRa(uint32_t freqHz, uint8_t bw, uint8_t sf, uint8_t cr,
                  uint16_t preambleLen, uint8_t payloadLen, bool implicitHeader,
                  bool crcOn, bool iqInverted);

  bool setFrequency(uint32_t freqHz);
  bool setSyncWord(uint8_t sync);
  bool setPower(int8_t dbm);

  bool startTx(const uint8_t* data, uint8_t len);
  bool startRx();
  bool standby();

  // Lê e limpa as interrupções pendentes. Devolve a máscara LR2021_IRQ_*.
  uint32_t irqStatus();
  void clearIrq();

  bool readPacket(uint8_t* out, uint8_t len);
  PacketStatus packetStatus();

  // RSSI instantâneo do canal, em dBm. Diferente do RSSI de pacote: mede o que
  // há no ar AGORA, com ou sem transmissor ligado.
  //
  // É o número que fecha a conta de um enlace. Sozinho, "RSSI -50 dBm" não diz
  // se o enlace é bom; contra um piso de -110 dBm são 60 dB de margem, contra
  // um piso de -55 dBm não sobra nada. Também é como se flagra saturação: com o
  // transmissor a centímetros, um piso que sobe junto denuncia o receptor
  // comprimido, e aí o RSSI de pacote deixa de servir pra comparar bandas.
  float rssiInstant();

  uint32_t frequencyHz() const { return freqHz_; }
  bool subGhz() const { return freqHz_ < 1000000000UL; }
  uint8_t payloadLen() const { return payloadLen_; }

 private:
  // Uma transação SPI com [opcode_hi, opcode_lo, dados...]. A resposta que
  // volta nos primeiros bytes é o status do comando ANTERIOR — é assim que o
  // LR2021 conversa, e por isso ler um resultado exige duas transações.
  uint16_t command(uint16_t opcode, const uint8_t* data = nullptr,
                   uint8_t len = 0);

  // Segunda transação: envia o que estiver em buf e recebe a resposta do
  // comando anterior no mesmo buf. Os dados úteis começam em buf[2].
  uint16_t response(uint8_t* buf, uint8_t len);

  bool waitBusy(uint32_t timeoutUs = 20000);
  bool checkVersion();
  bool loadPatchRam();
  bool writeRegMem32(uint32_t address, const uint32_t* words, uint8_t count);
  bool setPaConfig();
  bool setRxPath();
  void hardReset();

  Pins pins_{};
  SPISettings spi_{8000000UL, MSBFIRST, SPI_MODE0};
  uint32_t freqHz_ = 0;
  uint8_t payloadLen_ = 0;
  int8_t powerDbm_ = 0;
  uint16_t lastStatus_ = 0;
  bool ready_ = false;
};
