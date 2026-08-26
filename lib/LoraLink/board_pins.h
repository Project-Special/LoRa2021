#pragma once

// Ligação entre o ESP32 e o módulo LoRa2021 (LR2021).
//
// Os valores vêm das build flags do platformio.ini — os #define abaixo são só
// o fallback pra este arquivo compilar sozinho. Duas placas usam estas fontes:
//
//   sinal   ESP32-S3 DevKitC-1   ESP32 DevKit v1 (30 pinos)
//           (env esp32s3)        (env esp32dev)
//   -----   ------------------   --------------------------
//   SCK     40                   14  (D14)
//   MISO    38                   27  (D27)
//   MOSI    41                   13  (D13)
//   NSS     39                   26  (D26)
//   RST     42                   25  (D25)
//   BUSY     1                   33  (D33)
//   DIO9     2                   32  (D32)
//
// A pinagem do S3 é a mesma do SX1280 na IHM (Telas/lora_lrs.json), pra o
// LoRa2021 entrar na fiação existente. A do ESP32 clássico sai em fila única no
// header direito — justificativa pino a pino em docs/PINOUT.md.
//
// Numeração conforme o datasheet LoRa2021 V1.3, seção 7:
//
//   pino  nome         ESP32
//   ----  -----------  --------------------------------------------------
//    1    VCC          3V3   — 1,8..3,6 V; TX a 433 MHz puxa <120 mA
//    2    GND          GND     (também 8, 11, 12, 18)
//    3    MISO         PIN_LORA_MISO
//    4    MOSI         PIN_LORA_MOSI
//    5    SCK          PIN_LORA_SCK
//    6    NSS          PIN_LORA_NSS
//    7    BUSY         PIN_LORA_BUSY
//    9    ANT          antena sub-GHz (50 ohm)
//   10    2.4G/S_ANT   antena 2.4 GHz / banda S (50 ohm)
//   13    VTCXO        NÃO LIGAR — é SAÍDA, existe pra alimentar um TCXO
//                      EXTERNO opcional. Este módulo sai com CRISTAL
//                      (10 ppm contra 0,5 ppm de um TCXO), por isso
//                      LR2021_TCXO_VOLTAGE = 0.
//   14    RST          PIN_LORA_RST
//   15    DIO9         PIN_LORA_IRQ    (ver LR2021_IRQ_DIO_NUM)
//   16    DIO8         livre
//   17    DIO7         livre
//
// O módulo não tem pino "IRQ" rotulado: ele traz DIO7/DIO8/DIO9 crus e qual
// deles serve de interrupção é definido por SPI. Aqui usamos DIO9, que é o
// default do driver da Semtech.
//
// Também não precisa de chave de antena externa: são duas portas de RF
// independentes, uma por banda.

#ifndef PIN_LORA_SCK
#define PIN_LORA_SCK 18
#endif

#ifndef PIN_LORA_MISO
#define PIN_LORA_MISO 19
#endif

#ifndef PIN_LORA_MOSI
#define PIN_LORA_MOSI 23
#endif

#ifndef PIN_LORA_NSS
#define PIN_LORA_NSS 5
#endif

#ifndef PIN_LORA_RST
#define PIN_LORA_RST 25
#endif

#ifndef PIN_LORA_BUSY
#define PIN_LORA_BUSY 27
#endif

#ifndef PIN_LORA_IRQ
#define PIN_LORA_IRQ 26
#endif

// SPI clock for the LR2021. The chip handles 16 MHz, but keep some margin
// for dupont wiring on a prototype.
#ifndef LORA_SPI_FREQUENCY
#define LORA_SPI_FREQUENCY 8000000UL
#endif

#ifndef LR2021_TCXO_VOLTAGE
#define LR2021_TCXO_VOLTAGE 1.6f
#endif

#ifndef LR2021_IRQ_DIO_NUM
#define LR2021_IRQ_DIO_NUM 9
#endif
