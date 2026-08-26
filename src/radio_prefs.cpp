#include "radio_prefs.h"

#include <Preferences.h>

#include "settings.h"

namespace radioprefs {
namespace {

Preferences prefs;

// "há ajuste gravado" é uma chave própria, e não um valor sentinela dentro dos
// outros campos. Frequência 0 ou SF 0 seriam valores inválidos servindo de
// bandeira — e o dia em que um deles virar legítimo, a bandeira some junto.
constexpr const char* kFlag = "radioSet";

bool has_ = false;
LoraLink::State saved_{};

}  // namespace

void begin() {
  prefs.begin(settings::kNamespace, true);
  has_ = prefs.getBool(kFlag, false);
  if (has_) {
    saved_.band = static_cast<BandId>(prefs.getUChar("rBand", BAND_433));
    saved_.frequencyMHz = prefs.getFloat("rFreq", 433.0f);
    saved_.bandwidthKHz = prefs.getFloat("rBw", 125.0f);
    saved_.spreadingFactor = prefs.getUChar("rSf", 9);
    saved_.codingRate = prefs.getUChar("rCr", 7);
    saved_.powerDbm = prefs.getChar("rPwr", 22);
  }
  prefs.end();

  // Um valor corrompido na NVS não pode deixar o rádio mudo sem explicação:
  // melhor descartar o ajuste inteiro e cair no par, que é sempre válido.
  if (has_ && (!isValidFrequency(saved_.frequencyMHz) ||
               saved_.spreadingFactor < 5 || saved_.spreadingFactor > 12 ||
               saved_.codingRate < 4 || saved_.codingRate > 8)) {
    has_ = false;
  }
}

bool any() { return has_; }

void apply(LoraLink& radio) {
  if (!has_) return;

  // Campo a campo, e NÃO applyBand(): a banda é um preset que reescreveria
  // largura, SF e potência com os valores de fábrica dela — apagando
  // exatamente o ajuste fino que este módulo existe para preservar.
  //
  // A ordem repete a do painel. Frequência primeiro porque o teto do PA muda
  // com ela; potência por último, para ser validada contra a faixa já valendo.
  radio.setFrequency(saved_.frequencyMHz);
  radio.setBandwidth(saved_.bandwidthKHz);
  radio.setSpreadingFactor(saved_.spreadingFactor);
  radio.setCodingRate(saved_.codingRate);
  radio.setPower(saved_.powerDbm);
}

void save(const LoraLink::State& s) {
  saved_ = s;
  has_ = true;
  prefs.begin(settings::kNamespace, false);
  prefs.putBool(kFlag, true);
  prefs.putUChar("rBand", static_cast<uint8_t>(s.band));
  prefs.putFloat("rFreq", s.frequencyMHz);
  prefs.putFloat("rBw", s.bandwidthKHz);
  prefs.putUChar("rSf", s.spreadingFactor);
  prefs.putUChar("rCr", s.codingRate);
  prefs.putChar("rPwr", s.powerDbm);
  prefs.end();
}

void clear() {
  if (!has_) return;
  has_ = false;
  prefs.begin(settings::kNamespace, false);
  prefs.putBool(kFlag, false);
  prefs.end();
}

void print(Stream& out) {
  if (!has_) {
    out.println(F("  ajuste salvo : nenhum — a banda vem do par de teste"));
    return;
  }
  out.printf("  ajuste salvo : %.3f MHz  BW %.2f kHz  SF%u  CR 4/%u  %d dBm\n",
             saved_.frequencyMHz, saved_.bandwidthKHz, saved_.spreadingFactor,
             saved_.codingRate, saved_.powerDbm);
}

}  // namespace radioprefs
