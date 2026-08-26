#pragma once

#include <Arduino.h>

// Teste elétrico da fiação entre o ESP32 e o LoRa2021, pra quando o rádio não
// responde por SPI. Não fala SPI: só olha o que os pinos estão fazendo, o que
// separa "fio errado / módulo sem alimentação" de "fio certo, chip mudo".
namespace wirecheck {

// Roda o teste completo e imprime o laudo. Depois disso o barramento fica
// mexido: dê `reset` antes de tentar usar o rádio.
void run(Stream& out);

// Varre combinações de GPIO pras três linhas de dados (SCK, MOSI, MISO) e
// procura a que faz o LR2021 devolver a versão de firmware. Usa NSS, RST e
// BUSY como estão definidos — o teste de `run()` já os valida.
//
// Serve pra quando os fios estão bons mas em pinos trocados: em vez de conferir
// 21 combinações no olho, o firmware acha qual é.
void scan(Stream& out);

}  // namespace wirecheck
