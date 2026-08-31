#pragma once

#include <Arduino.h>

#include "LoraLink.h"
#include "radio_profile.h"

// -----------------------------------------------------------------------------
// Tudo que é específico do ExpressLRS vive aqui.
//
// Este firmware é a BANCADA: LoRa cru, quadros de texto próprios. Ele NÃO
// implementa o ExpressLRS. O que existe neste módulo é o necessário pra
// ESCUTAR um transmissor ELRS e reconhecer o que é dele:
//
//   - derivar o UID a partir da frase de binding (o mesmo hash do ELRS)
//   - pôr o rádio na camada física do ELRS (implícito, CRC de hardware off,
//     IQ invertido conforme o UID)
//   - validar o CRC14 do ELRS em software, porque com o CRC de hardware
//     desligado o rádio entrega qualquer preâmbulo falso como "pacote"
//
// Limite conhecido: só o pacote SYNC é validável às cegas. O RCDATA em modo
// wide carrega o nonce dentro do campo de CRC, e o nonce só se conhece depois
// de sincronizar — o que é, na prática, ser um receptor ExpressLRS. Para isso
// existe o firmware de verdade em elrs/v3-lr2021.
// -----------------------------------------------------------------------------
namespace express {

// Deriva o UID da frase de binding e carrega o par escolhido da NVS.
void begin();

// ---- identidade -------------------------------------------------------------

const uint8_t* uid();          // 6 bytes
const char* phrase();
bool iqInverted();             // UID[5] & 1, igual ao ELRS
String uidText();              // "97 A9 EF C9 8B ED"

// Troca a frase de binding e recalcula o UID. Persiste na NVS: a frase é do
// transmissor com que se quer casar, não do firmware, então tem de sobreviver
// a uma regravação — e mudar de transmissor não pode exigir recompilar.
//
// Devolve false se a frase não couber no buffer. Quem chama precisa REAPLICAR
// o par depois: a inversão de IQ sai do UID, e o UID acabou de mudar.
bool setPhrase(const String& text);

// Frase de fábrica, a do build flag BIND_PHRASE. Serve pro painel oferecer
// "voltar ao padrão" sem ter de saber o valor.
const char* defaultPhrase();

// ---- par de teste -----------------------------------------------------------

PeerId peer();
const PeerProfile& peerInfo();

// Aplica o par no rádio (modulação + camada física) e persiste a escolha.
// Devolve o código de erro do LoraLink.
int16_t applyPeer(LoraLink& radio, PeerId id);

// Resolve "bancada" | "elrs2g4" | "elrs900". false = token desconhecido.
bool peerFromToken(const String& token, PeerId& out);

// ---- geração de pacote (simulador de transmissor) ---------------------------

// Monta um pacote SYNC do ExpressLRS OTA v3 em `out` (8 bytes), com o CRC14
// semeado pelo nosso UID — o mesmo que um transmissor de verdade emite.
//
// Serve pra ter um transmissor de referência sem depender do rádio comercial
// estar ligado e ao alcance: o receptor valida estes pacotes pelo caminho
// idêntico, então um teste de alcance feito contra o simulador mede o enlace,
// não a disponibilidade do equipamento de terceiro.
//
// Layout, conferido contra tx_main.cpp da 3.6.4 e contra pacotes reais
// capturados no ar:
//   byte 0  crcHigh(6) | tipo(2)      tipo 2 = SYNC
//   byte 1  fhssIndex
//   byte 2  nonce
//   byte 3  rateIndex(4) | newTlmRatio(3) | switchEncMode(1)
//   bytes 4..6  UID[3], UID[4], UID[5]
//   byte 7  crcLow
void buildSync(uint8_t* out, uint8_t fhssIndex, uint8_t nonce,
               uint8_t rateIndex, uint8_t tlmRatio = 4,
               bool switchEncMode = false);

// ---- canais de RC -----------------------------------------------------------

/**
 * Posição dos manches e das chaves, decodificada de um pacote RCDATA.
 *
 * Quatro canais de 10 bits (AETR) mais um byte de chaves, que é o formato
 * OTA4 do ExpressLRS em `smWideOr8ch` — ver OTA_Packet4_s.rc no OTA.h da 3.6.4.
 */
struct RcChannels {
  /** 0..1023, na ordem A E T R. Escala crua do ar, sem converter para CRSF. */
  uint16_t ch[4];
  /** 7 bits de chaves + o bit alto do AUX1. */
  uint8_t switches;
  uint8_t ch4;
  /** Nonce que validou o CRC. Serve de número de sequência. */
  uint8_t nonce;
};

/**
 * Tenta ler um RCDATA e extrair os canais.
 *
 * O CRC do RCDATA é semeado com `OtaCrcInitializer ^ OtaNonce` (OTA.cpp:531),
 * e o nonce só se conhece estando sincronizado. MAS ele é um uint8_t: são 256
 * chaves possíveis, e testar todas custa ~14 mil operações — microssegundos no
 * ESP32. É isso que torna a decodificação possível sem ser um receptor.
 *
 * O preço é falso positivo: um CRC de 14 bits contra 256 chaves aceita ruído
 * com probabilidade ~1,6% por pacote. Por isso `rcValid()` só passa a valer
 * depois de alguns pacotes coerentes — ver rcCount().
 */
/**
 * Monta um RCDATA do ExpressLRS em `out` (8 bytes).
 *
 * O simulador so emitia SYNC, e SYNC nao carrega manche nenhum — por isso as
 * barras do painel ficavam vazias mesmo com o enlace vivo. Um transmissor de
 * verdade alterna RCDATA e SYNC; aqui o simulador passa a fazer o mesmo, e o
 * receptor decodifica os dois pelo mesmo caminho.
 *
 * `ch` sao 4 canais de 10 bits (0..1023), na ordem A E T R.
 */
void buildRc(uint8_t* out, uint8_t nonce, const uint16_t ch[4], uint8_t switches);

bool decodeRc(const uint8_t* p, uint8_t len, RcChannels& out);

/** Último RCDATA válido, e há quanto tempo. */
const RcChannels& rc();
uint32_t rcAgeMs();
uint32_t rcCount();

// ---- validação de pacote ----------------------------------------------------

// true = os bytes passam no CRC14 do ELRS semeado pelo nosso UID.
bool crcOk(const uint8_t* p, uint8_t len);

// Valida e descreve um pacote cru em uma linha ("97 A9 ... [SYNC]").
// false = não passou no CRC, ou seja é ruído: não deve ser contado nem exibido.
bool describe(const uint8_t* p, uint8_t len, String& out);

uint32_t validCount();         // pacotes que passaram no CRC desde o boot

// Pacotes CRUS que o rádio demodulou no modo escuta, tenham passado no CRC ou
// não.
//
// Existe porque sem ele o modo escuta é cego a meio caminho: com a frase de
// binding errada, o CRC14 reprova tudo e a tela fica idêntica a "não há
// transmissor nenhum no ar". Este contador separa as duas situações — se ele
// sobe, há sinal audível e o que falta é a frase ou a taxa.
uint32_t rawCount();

}  // namespace express
