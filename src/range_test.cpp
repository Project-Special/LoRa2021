#include "range_test.h"

#include <Preferences.h>

#include "settings.h"

namespace range {
namespace {

// Papel de fábrica. O env do S3 compila com RANGE_ROLE_TX; o do ESP32 clássico
// fica no default, receptor.
#ifdef RANGE_ROLE_TX
constexpr Role kDefaultRole = Role::Tx;
#else
constexpr Role kDefaultRole = Role::Rx;
#endif

// 4 quadros por segundo. É denso o suficiente pra o LQ reagir enquanto se
// caminha, e folgado o suficiente pra caber o time-on-air de SF9/125 kHz com
// margem — em SF12 o intervalo precisa subir, e o comando `rate` existe pra
// isso.
#ifndef RANGE_INTERVAL_MS
#define RANGE_INTERVAL_MS 250
#endif

// Janela do LQ. 100 quadros a 4 Hz = 25 s de histórico: longo o bastante pra
// não oscilar a cada passo, curto o bastante pra acusar a queda antes de você
// andar mais 50 m.
constexpr uint8_t kWindow = 100;

// Cadência real entre quadros, informada pelo loop. Começa no valor pedido e é
// corrigida assim que o rádio diz quanto tempo cada quadro ocupa no ar.
uint32_t cadenceMs_ = RANGE_INTERVAL_MS;

// Um relatório a cada 20 quadros (5 s). Raro o bastante pra quase não roubar ar
// do enlace medido, frequente o bastante pra acompanhar quem caminha.
constexpr uint8_t kAckEvery = 20;

Role role_ = kDefaultRole;
uint32_t intervalMs_ = RANGE_INTERVAL_MS;

// Janela deslizante de recebidos. Um bit por quadro esperado.
uint8_t window_[kWindow] = {0};
uint8_t windowUsed_ = 0;
uint8_t windowHead_ = 0;

uint32_t received_ = 0;
uint32_t lost_ = 0;
uint32_t lastSeq_ = 0;
bool haveSeq_ = false;
uint32_t lastRxMs_ = 0;
float rssi_ = 0.0f;
float snr_ = 0.0f;
uint8_t sinceAck_ = 0;

String lastAck_;
uint32_t lastAckMs_ = 0;

void push(bool ok) {
  window_[windowHead_] = ok ? 1 : 0;
  windowHead_ = (windowHead_ + 1) % kWindow;
  if (windowUsed_ < kWindow) ++windowUsed_;
}

}  // namespace

void begin() {
  Preferences p;
  p.begin(settings::kNamespace, true);
  const uint8_t v = p.getUChar("role", static_cast<uint8_t>(kDefaultRole));
  p.end();
  role_ = (v == static_cast<uint8_t>(Role::Tx)) ? Role::Tx : Role::Rx;
}

Role role() { return role_; }

const char* roleName() {
  return role_ == Role::Tx ? "TX (transmissor)" : "RX (receptor)";
}

void setRole(Role r) {
  role_ = r;
  Preferences p;
  p.begin(settings::kNamespace, false);
  p.putUChar("role", static_cast<uint8_t>(r));
  p.end();
}

bool roleFromToken(const String& token, Role& out) {
  if (token.equalsIgnoreCase("rx")) { out = Role::Rx; return true; }
  if (token.equalsIgnoreCase("tx")) { out = Role::Tx; return true; }
  return false;
}

void onFrame(uint32_t seq, float rssiDbm, float snrDb) {
  rssi_ = rssiDbm;
  snr_ = snrDb;
  lastRxMs_ = millis();
  ++received_;
  ++sinceAck_;

  // Buracos na numeração são os quadros que não chegaram. O transmissor pode
  // ter reiniciado (seq volta pra trás) — nesse caso recomeça a contagem em vez
  // de somar um "perdido" gigante.
  if (haveSeq_ && seq > lastSeq_) {
    const uint32_t gap = seq - lastSeq_ - 1;
    // Um salto absurdo é reinício do outro lado, não perda real.
    if (gap > 0 && gap < kWindow) {
      lost_ += gap;
      for (uint32_t i = 0; i < gap; ++i) push(false);
    }
  }
  haveSeq_ = true;
  lastSeq_ = seq;
  push(true);
}

uint8_t lq() {
  if (windowUsed_ == 0) return 0;
  uint16_t ok = 0;
  for (uint8_t i = 0; i < windowUsed_; ++i) ok += window_[i];
  return static_cast<uint8_t>((ok * 100UL) / windowUsed_);
}

uint32_t received() { return received_; }
uint32_t lost() { return lost_; }
float rssi() { return rssi_; }
float snr() { return snr_; }

bool linked() {
  // Três cadências: um quadro perdido é normal, três seguidos não são.
  const uint32_t timeout = cadenceMs_ * 3 + 250;
  return lastRxMs_ != 0 && millis() - lastRxMs_ < timeout;
}

bool ackDue() {
  if (sinceAck_ < kAckEvery) return false;
  sinceAck_ = 0;
  return true;
}

String ackPayload() {
  char b[48];
  snprintf(b, sizeof(b), "lq=%u rssi=%.0f snr=%.1f", lq(), rssi_, snr_);
  return String(b);
}

void onAck(const String& payload, float rssiDbm, float snrDb) {
  lastAck_ = payload;
  lastAckMs_ = millis();
  // No transmissor, RSSI/SNR guardados são os do relatório que voltou: é o
  // enlace de retorno, e serve pra ver assimetria entre os dois sentidos.
  rssi_ = rssiDbm;
  snr_ = snrDb;
}

const String& lastAck() { return lastAck_; }
uint32_t lastAckMs() { return lastAckMs_; }

uint32_t intervalMs() { return intervalMs_; }

void noteCadence(uint32_t ms) {
  if (ms >= 50) cadenceMs_ = ms;
}

void setIntervalMs(uint32_t ms) {
  if (ms < 50) ms = 50;
  if (ms > 10000) ms = 10000;
  intervalMs_ = ms;
}

void printStats(Stream& out) {
  out.println();
  out.printf("  papel        : %s\n", roleName());
  out.printf("  intervalo    : %lu ms pedido / %lu ms real\n",
             static_cast<unsigned long>(intervalMs_),
             static_cast<unsigned long>(cadenceMs_));
  if (role_ == Role::Rx) {
    out.printf("  LQ           : %u %%   (janela de %u quadros)\n", lq(),
               windowUsed_);
    out.printf("  recebidos    : %lu    perdidos: %lu\n",
               static_cast<unsigned long>(received_),
               static_cast<unsigned long>(lost_));
    out.printf("  RSSI / SNR   : %.1f dBm / %.1f dB\n", rssi_, snr_);
    out.printf("  enlace       : %s\n", linked() ? "vivo" : "sem sinal");
  } else {
    if (lastAckMs_) {
      out.printf("  relato do RX : %s   (ha %lu s)\n", lastAck_.c_str(),
                 static_cast<unsigned long>((millis() - lastAckMs_) / 1000));
      out.printf("  retorno      : RSSI %.1f dBm / SNR %.1f dB\n", rssi_, snr_);
    } else {
      out.println(F("  relato do RX : nenhum ainda"));
    }
  }
}

}  // namespace range
