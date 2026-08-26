#pragma once

#include <Arduino.h>

// Teste de alcance entre duas placas.
//
// Um lado TRANSMITE quadros numerados num intervalo fixo; o outro RECEBE, conta
// os que faltaram pela numeração e devolve, de vez em quando, o que está vendo
// — LQ, RSSI e SNR. Assim quem caminha com o transmissor lê o enlace do ponto
// de vista do receptor, que é o que interessa medir.
//
// O papel vem da build flag (RANGE_ROLE_TX no env do S3) e pode ser trocado em
// runtime pelo comando `role`, que persiste na NVS: as duas placas rodam o
// mesmo binário e não há risco de gravar a errada.
namespace range {

enum class Role : uint8_t { Rx, Tx };

void begin();

Role role();
const char* roleName();
void setRole(Role r);            // persiste na NVS
bool roleFromToken(const String& token, Role& out);

// --- lado receptor -----------------------------------------------------------

// Registra um quadro de alcance recebido. `seq` é o contador do transmissor —
// é dele que sai a contagem de perdidos.
void onFrame(uint32_t seq, float rssi, float snr);

uint8_t lq();                    // 0..100 %, janela deslizante
uint32_t received();
uint32_t lost();
float rssi();
float snr();

// Enlace vivo = chegou quadro há pouco. É o que decide o LED.
bool linked();

// true quando é hora de devolver um relatório ao transmissor.
bool ackDue();
String ackPayload();

// --- lado transmissor --------------------------------------------------------

// Relatório vindo do receptor, já formatado pra impressão.
void onAck(const String& payload, float rssi, float snr);
const String& lastAck();
uint32_t lastAckMs();

// --- comum -------------------------------------------------------------------

uint32_t intervalMs();
void setIntervalMs(uint32_t ms);

// Informa a cadência REAL entre quadros — que em modulações lentas é maior que
// a pedida, porque o tempo no ar manda. É dela que sai o prazo para declarar o
// enlace caído: com um valor fixo, trocar para SF9/125 kHz fazia o receptor
// anunciar "sem sinal" no intervalo normal entre dois quadros.
void noteCadence(uint32_t ms);

void printStats(Stream& out);

}  // namespace range
