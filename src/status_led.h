#pragma once

#include <Arduino.h>

// LED azul de status. Três estados, legíveis do outro lado do campo sem
// notebook aberto:
//
//   apagado   o módulo LoRa2021 não foi encontrado
//   aceso     rádio ok, esperando o outro lado
//   piscando  enlace vivo — chegando quadro do par
//
// Não bloqueia: quem pisca é o loop, chamando update() a cada volta.
namespace statusled {

enum class Mode : uint8_t {
  NoRadio,    // apagado
  Waiting,    // aceso
  Linked,     // piscando
};

void begin();
void set(Mode m);
void update();

}  // namespace statusled
