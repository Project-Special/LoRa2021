#include "settings.h"

#include <Preferences.h>

namespace settings {

void begin() {
  // Abrir em modo ESCRITA é o que cria o namespace. Sem isto, numa placa
  // recém-gravada (ou depois de `pio run -t erase`) cada leitura tropeça num
  // namespace que ainda não existe e o core cospe:
  //
  //   [E][Preferences.cpp:50] begin(): nvs_open failed: NOT_FOUND
  //
  // Uma linha dessas por leitura — três no boot — pra relatar algo normal:
  // ainda não há nada salvo. As leituras já tratam o caso, devolvendo o
  // default; o que incomoda é o erro no log, que num bring-up manda investigar
  // o que não está quebrado.
  Preferences p;
  p.begin(kNamespace, false);
  p.end();
}

}  // namespace settings
