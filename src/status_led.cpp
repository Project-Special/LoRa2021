#include "status_led.h"

namespace statusled {
namespace {

// O pino vem do env, porque não é o mesmo nas duas placas — e pode não existir:
// no S3 o GPIO2 já leva o IRQ do rádio e o LED de bordo é endereçável. Sem
// PIN_STATUS_LED definido, este módulo inteiro vira no-op, e o resto do
// firmware não precisa saber disso.
#ifdef PIN_STATUS_LED
constexpr bool kHaveLed = true;
#else
constexpr bool kHaveLed = false;
#define PIN_STATUS_LED 0
#endif

// Alguns módulos trazem o LED ligado ao 3V3 em vez do GND, e aí a lógica se
// inverte. Uma flag evita ter que reescrever o arquivo pra descobrir isso.
#ifndef STATUS_LED_ACTIVE_LOW
#define STATUS_LED_ACTIVE_LOW 0
#endif

// Rápido o bastante pra ler como "piscando" de relance, lento o bastante pra
// não virar brilho contínuo aos olhos.
constexpr uint32_t kBlinkMs = 150;

Mode mode_ = Mode::NoRadio;
uint32_t lastToggle_ = 0;
bool phase_ = false;

void write(bool on) {
  if (!kHaveLed) return;
#if STATUS_LED_ACTIVE_LOW
  digitalWrite(PIN_STATUS_LED, on ? LOW : HIGH);
#else
  digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW);
#endif
}

}  // namespace

void begin() {
  if (!kHaveLed) return;
  pinMode(PIN_STATUS_LED, OUTPUT);
  write(false);
}

void set(Mode m) {
  if (m == mode_) return;
  mode_ = m;
  phase_ = false;
  lastToggle_ = millis();
  // Escreve já: sem isto, sair de "piscando" deixaria o LED no estado em que a
  // última troca o pegou.
  write(m == Mode::Waiting);
}

void update() {
  if (!kHaveLed || mode_ != Mode::Linked) return;
  const uint32_t now = millis();
  if (now - lastToggle_ < kBlinkMs) return;
  lastToggle_ = now;
  phase_ = !phase_;
  write(phase_);
}

}  // namespace statusled
