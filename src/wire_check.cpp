#include "wire_check.h"

#include <SPI.h>

#include "board_pins.h"

namespace wirecheck {
namespace {

// O que um pino está fazendo quando o ESP32 só observa.
enum class Level {
  Floating,   // segue o pull interno: ninguém do outro lado dirige a linha
  StuckLow,   // fica em 0 mesmo com pull-up: algo segura em GND
  StuckHigh,  // fica em 1 mesmo com pull-down: algo segura em 3V3
};

const char* levelName(Level l) {
  switch (l) {
    case Level::StuckLow:  return "em 0";
    case Level::StuckHigh: return "em 1";
    default:               return "solto";
  }
}

// Liga o pull-up interno e lê; liga o pull-down e lê de novo. Se o pino
// acompanhou os dois pulls, não há nada do outro lado com força pra segurá-lo —
// é fio solto, ou um pino de ENTRADA do módulo (alta impedância), ou o módulo
// sem alimentação. Se ficou firme num nível, alguém está dirigindo.
Level probe(uint8_t pin) {
  pinMode(pin, INPUT_PULLUP);
  delayMicroseconds(500);
  const int up = digitalRead(pin);
  pinMode(pin, INPUT_PULLDOWN);
  delayMicroseconds(500);
  const int down = digitalRead(pin);
  pinMode(pin, INPUT);
  if (up && !down) return Level::Floating;
  if (!up && !down) return Level::StuckLow;
  return Level::StuckHigh;
}

// Curto duro numa linha que o ESP32 dirige: manda 1, lê 1; manda 0, lê 0.
// Ler o contrário do que se escreveu é fio encostado em GND ou em 3V3.
const char* driveFault(uint8_t pin) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, HIGH);
  delayMicroseconds(500);
  const int hi = digitalRead(pin);
  digitalWrite(pin, LOW);
  delayMicroseconds(500);
  const int lo = digitalRead(pin);
  pinMode(pin, INPUT);
  if (!hi) return "CURTO em GND";
  if (lo)  return "CURTO em 3V3";
  return nullptr;
}

}  // namespace

void run(Stream& out) {
  out.println();
  out.println(F("=== teste de fiacao LoRa2021 ========================"));

  // --- 1. quem dirige cada linha --------------------------------------------
  //
  // Com NSS em repouso, as ENTRADAS do módulo (SCK, MOSI, NSS, RST) ficam em
  // alta impedância e o MISO também — o LR2021 só dirige o MISO enquanto NSS
  // está baixo. Ou seja: "solto" nessas cinco é o normal.
  //
  // BUSY e DIO9 são o oposto: são SAÍDAS do módulo, dirigidas o tempo todo
  // desde que o módulo tenha 3V3. Se aparecerem como "solto", a conclusão é
  // dura — ou o fio não chegou, ou o módulo não está alimentado.
  struct Line {
    const char* name;
    uint8_t pin;
    bool drivenByModule;
  };
  const Line lines[] = {
      {"SCK ", PIN_LORA_SCK,  false},
      {"MOSI", PIN_LORA_MOSI, false},
      {"MISO", PIN_LORA_MISO, false},
      {"NSS ", PIN_LORA_NSS,  false},
      {"RST ", PIN_LORA_RST,  false},
      {"BUSY", PIN_LORA_BUSY, true},
      // DIO9 fica em alta impedância até o SPI configurá-lo como IRQ
      // (LR2021_IRQ_DIO_NUM). Com o chip não detectado essa configuração
      // nunca aconteceu, então "solto" aqui é o normal — não é defeito.
      {"DIO9", PIN_LORA_IRQ,  false},
  };

  uint8_t silent = 0;
  out.println(F("  linha  GPIO  estado   leitura"));
  for (const Line& l : lines) {
    const Level lvl = probe(l.pin);
    const char* verdict = "ok";
    if (l.drivenByModule && lvl == Level::Floating) {
      verdict = "<<< NINGUEM DIRIGE (fio solto ou modulo sem 3V3)";
      ++silent;
    } else if (!l.drivenByModule && lvl != Level::Floating) {
      verdict = "(preso — ver teste de curto abaixo)";
    }
    out.printf("  %s   %-4d  %-7s  %s\n", l.name, l.pin, levelName(lvl), verdict);
  }

  // --- 2. curto nas linhas que o ESP32 dirige -------------------------------
  out.println(F("  --- curtos nas saidas do ESP32 ---"));
  bool anyShort = false;
  const Line outputs[] = {
      {"SCK ", PIN_LORA_SCK,  false},
      {"MOSI", PIN_LORA_MOSI, false},
      {"NSS ", PIN_LORA_NSS,  false},
      {"RST ", PIN_LORA_RST,  false},
  };
  for (const Line& l : outputs) {
    if (const char* fault = driveFault(l.pin)) {
      out.printf("  %s   GPIO %-4d  %s\n", l.name, l.pin, fault);
      anyShort = true;
    }
  }
  if (!anyShort) out.println(F("  nenhum — as quatro linhas sobem e descem livres"));

  // --- 3. o modulo reage ao reset? ------------------------------------------
  //
  // Este é o teste que vale por todos: o LR2021 segura o BUSY ALTO enquanto
  // faz o boot interno e só depois o solta. Ver essa borda é a prova de que o
  // módulo está vivo, alimentado e com o NRESET chegando nele — mesmo que o
  // SPI ainda não funcione.
  out.println(F("  --- pulso de reset, olhando o BUSY ---"));
  pinMode(PIN_LORA_BUSY, INPUT);
  pinMode(PIN_LORA_RST, OUTPUT);
  digitalWrite(PIN_LORA_RST, LOW);
  delay(5);
  const int busyInReset = digitalRead(PIN_LORA_BUSY);
  digitalWrite(PIN_LORA_RST, HIGH);

  const uint32_t t0 = micros();
  int seenHigh = 0;
  uint32_t fellAt = 0;
  while (micros() - t0 < 500000UL) {  // 500 ms é folga larga: o boot leva ~1 ms
    const int b = digitalRead(PIN_LORA_BUSY);
    if (b) seenHigh = 1;
    if (seenHigh && !b) { fellAt = micros() - t0; break; }
  }
  pinMode(PIN_LORA_RST, INPUT);

  delay(50);
  const int busyIdle = digitalRead(PIN_LORA_BUSY);
  out.printf("  BUSY com NRESET em 0 : %d\n", busyInReset);
  if (fellAt) {
    out.printf("  BUSY subiu e caiu em %lu us  -> MODULO VIVO\n",
               static_cast<unsigned long>(fellAt));
  } else if (seenHigh) {
    out.println(F("  BUSY subiu e NAO caiu em 500 ms -> modulo travado no boot"));
    out.println(F("     (alimentacao fraca, ou TCXO configurado sem TCXO na placa)"));
  } else {
    out.println(F("  BUSY nao se mexeu -> o modulo nao viu o reset"));
  }
  // Um BUSY que cai no boot e torna a subir sozinho é outro defeito: o chip
  // entra em algum ciclo interno e nunca fica pronto. Sem esta leitura, o teste
  // de SPI abaixo mediria um BUSY já alto e leria isso como "o NSS chegou".
  out.printf("  BUSY em repouso, 50 ms depois : %d  (%s)\n", busyIdle,
             busyIdle ? "NAO deveria — chip ocupado" : "ok, chip pronto");

  // --- 4. o chip responde ao SPI? -------------------------------------------
  //
  // Com o BUSY provado vivo, ele vira o oráculo: dá pra saber ONDE o SPI para
  // sem depender do MISO. O LR2021 levanta o BUSY quando começa a processar
  // uma transação, então:
  //
  //   BUSY não mexe com NSS+clock  -> NSS, SCK ou MOSI no pino errado
  //   BUSY mexe mas a leitura é fixa -> só o MISO está errado
  //
  // GET_VERSION (0x0101) é o mesmo comando que o driver usa pra detectar o
  // chip, e o que devolveu "0.0" no boot.
  out.println(F("  --- SPI: o chip reage ao comando? ---"));
  pinMode(PIN_LORA_BUSY, INPUT);
  pinMode(PIN_LORA_NSS, OUTPUT);
  digitalWrite(PIN_LORA_NSS, HIGH);
  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  uint8_t rx[4] = {0};

  // O BUSY precisa ser amostrado DENTRO da transação, não depois: no LR2021 ele
  // sobe na borda de descida do NSS e desce quando o comando termina. Só olhar
  // depois de soltar o NSS é uma corrida — o pulso pode já ter passado, e o
  // teste acusaria "não reagiu" numa fiação boa.
  //
  // Amostrar em três pontos separa qual fio falta:
  //   NSS↓ sozinho já levanta o BUSY  -> o NSS chega no módulo
  //   sobe só depois do clock         -> NSS ok, SCK ok
  //   não sobe nunca                  -> NSS ou SCK no pino errado
  SPI.beginTransaction(SPISettings(1000000UL, MSBFIRST, SPI_MODE0));
  const int busyBeforeNss = digitalRead(PIN_LORA_BUSY);
  digitalWrite(PIN_LORA_NSS, LOW);
  delayMicroseconds(10);
  const int busyOnNss = digitalRead(PIN_LORA_BUSY);
  SPI.transfer(0x01);
  const int busyMidCmd = digitalRead(PIN_LORA_BUSY);
  SPI.transfer(0x01);
  const int busyEndCmd = digitalRead(PIN_LORA_BUSY);
  digitalWrite(PIN_LORA_NSS, HIGH);

  bool busyAfter = false;
  for (uint32_t t = micros(); micros() - t < 2000;) {
    if (digitalRead(PIN_LORA_BUSY)) { busyAfter = true; break; }
  }
  // Timeout obrigatório: BUSY preso em 1 é justamente um dos defeitos que este
  // teste existe pra encontrar, e não pode virar travamento.
  for (uint32_t t = micros(); digitalRead(PIN_LORA_BUSY) && micros() - t < 10000;) {
  }
  // Segunda transação: é nela que o LR2021 entrega a resposta do comando
  // anterior. O primeiro byte é o status — num chip vivo, nunca 0x00 nem 0xFF.
  digitalWrite(PIN_LORA_NSS, LOW);
  for (uint8_t i = 0; i < sizeof(rx); ++i) rx[i] = SPI.transfer(0x00);
  digitalWrite(PIN_LORA_NSS, HIGH);
  SPI.endTransaction();
  SPI.end();

  // Só conta como reação se houve TRANSIÇÃO. Um BUSY que já estava alto não
  // prova que o NSS chegou — prova apenas que o chip está ocupado.
  // Quanto tempo o BUSY fica alto por causa do NSS, sem nenhum clock.
  //
  // É o que separa duas leituras opostas do mesmo sintoma:
  //   dezenas de us          -> o chip aceitou uma transação. NSS é NSS.
  //   ~ o mesmo do reset     -> baixar esse fio RESETA o módulo, ou seja ele
  //                             não está no NSS do módulo, está no NRESET.
  pinMode(PIN_LORA_NSS, OUTPUT);
  digitalWrite(PIN_LORA_NSS, HIGH);
  for (uint32_t t = micros(); digitalRead(PIN_LORA_BUSY) && micros() - t < 50000;) {
  }
  digitalWrite(PIN_LORA_NSS, LOW);
  delayMicroseconds(5);
  digitalWrite(PIN_LORA_NSS, HIGH);
  uint32_t nssBusyUs = 0;
  {
    const uint32_t t0 = micros();
    while (micros() - t0 < 50000UL) {
      if (!digitalRead(PIN_LORA_BUSY)) { nssBusyUs = micros() - t0; break; }
    }
  }
  out.printf("  BUSY alto por pulso de NSS : %lu us  (reset levou %lu us)\n",
             static_cast<unsigned long>(nssBusyUs),
             static_cast<unsigned long>(fellAt));

  const bool busyStuck = busyBeforeNss == 1;
  const bool busyMoved =
      !busyStuck && (busyOnNss || busyMidCmd || busyEndCmd || busyAfter);
  out.printf("  BUSY antes do NSS      : %d\n", busyBeforeNss);
  out.printf("  BUSY com NSS baixo     : %d  (antes de qualquer clock)\n",
             busyOnNss);
  out.printf("  BUSY durante o comando : %d %d   depois: %d\n", busyMidCmd,
             busyEndCmd, busyAfter ? 1 : 0);
  out.printf("  resposta crua          : %02X %02X %02X %02X\n",
             rx[0], rx[1], rx[2], rx[3]);

  const bool allZero = (rx[0] | rx[1] | rx[2] | rx[3]) == 0x00;
  const bool allOnes = (rx[0] & rx[1] & rx[2] & rx[3]) == 0xFF;

  // --- 5. o chip esta OUVINDO o que mandamos? -------------------------------
  //
  // A resposta chega (os bytes de status não são 00 nem FF, então o MISO
  // funciona), mas a versão vem 0. Falta saber se o comando ENVIADO chega lá.
  //
  // O teste: mandar comandos diferentes e comparar as respostas. Um chip que
  // ouve responde coisas diferentes. Respostas idênticas byte a byte só têm uma
  // explicação — ele recebe a mesma coisa dos três, ou seja, não recebe nada:
  // o MOSI não chega no módulo.
  //
  // Formato igual ao do driver do ExpressLRS (LR2021Driver::CheckVersion):
  // dois bytes de status, depois os dados. GET_VERSION deve trazer 01 18.
  out.println(F("  --- o chip ouve o MOSI? ---"));
  const uint16_t cmds[] = {0x0101, 0x0102, 0x011B};
  const char* cmdNames[] = {"GET_VERSION", "GET_ERRORS ", "GET_STATUS "};
  uint8_t resp[3][4] = {{0}};

  for (uint8_t k = 0; k < 3; ++k) {
    pinMode(PIN_LORA_NSS, OUTPUT);
    digitalWrite(PIN_LORA_NSS, HIGH);
    pinMode(PIN_LORA_RST, OUTPUT);
    digitalWrite(PIN_LORA_RST, LOW);
    delay(10);
    digitalWrite(PIN_LORA_RST, HIGH);
    delay(300);  // transição típica do LR2021, igual à do driver
    for (uint32_t t = millis(); digitalRead(PIN_LORA_BUSY) && millis() - t < 500;) {
    }

    SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);
    SPI.beginTransaction(SPISettings(1000000UL, MSBFIRST, SPI_MODE0));
    digitalWrite(PIN_LORA_NSS, LOW);
    SPI.transfer(cmds[k] >> 8);
    SPI.transfer(cmds[k] & 0xFF);
    digitalWrite(PIN_LORA_NSS, HIGH);
    for (uint32_t t = micros(); digitalRead(PIN_LORA_BUSY) && micros() - t < 50000;) {
    }
    digitalWrite(PIN_LORA_NSS, LOW);
    for (uint8_t i = 0; i < 4; ++i) resp[k][i] = SPI.transfer(0x00);
    digitalWrite(PIN_LORA_NSS, HIGH);
    SPI.endTransaction();
    SPI.end();

    out.printf("  %s (%04X) -> %02X %02X %02X %02X\n", cmdNames[k], cmds[k],
               resp[k][0], resp[k][1], resp[k][2], resp[k][3]);
  }

  const bool sameAnswer = memcmp(resp[0], resp[1], 4) == 0 &&
                          memcmp(resp[0], resp[2], 4) == 0;
  const bool versionOk = resp[0][2] == 0x01 && resp[0][3] == 0x18;

  // --- laudo ----------------------------------------------------------------
  out.println(F("  --- conclusao ---"));
  if (versionOk) {
    out.println(F("  O CHIP RESPONDEU 1.24: a fiacao esta CERTA."));
  } else if (sameAnswer) {
    out.println(F("  tres comandos DIFERENTES, a mesma resposta byte a byte:"));
    out.println(F("  o chip nao esta recebendo o que mandamos."));
    out.println(F("  MISO e SCK funcionam (a resposta chega e nao e 00/FF),"));
    out.println(F("  entao o fio que falta e o MOSI — do lado do MODULO."));
    out.printf("  confira o pino 4 (MOSI) do LoRa2021 contra o GPIO %d.\n",
               PIN_LORA_MOSI);
  } else if (silent) {
    out.println(F("  uma saida do modulo esta muda: confira 3V3, GND e essa linha."));
  } else if (anyShort) {
    out.println(F("  ha curto: resolva antes de olhar o SPI."));
  } else if (!fellAt) {
    out.println(F("  o modulo nao reage ao reset: alimentacao ou NRESET."));
  } else if (busyStuck) {
    out.println(F("  BUSY ja estava ALTO antes de qualquer SPI: o chip nunca"));
    out.println(F("  terminou de ficar pronto. Nao e fiacao de dados — olhe"));
    out.println(F("  alimentacao sob carga e LR2021_TCXO_VOLTAGE."));
  } else if (!busyMoved) {
    out.println(F("  modulo vivo, mas nao reage a NENHUMA parte da transacao."));
    out.println(F("  nem o NSS chega nele: confira o fio do NSS e o do SCK"));
    out.println(F("  (trocados entre si, ou um deles no pino errado do header)."));
  } else if (nssBusyUs > 1000 && fellAt && nssBusyUs > fellAt / 2) {
    out.println(F("  baixar o 'NSS' segura o BUSY tanto quanto um RESET:"));
    out.println(F("  esse fio esta no NRESET do modulo, nao no NSS."));
    out.println(F("  os fios de NSS e RST estao trocados no lado do MODULO."));
  } else if (busyOnNss && !busyBeforeNss && allZero) {
    out.println(F("  o NSS chega no modulo (o BUSY sobe com ele), mas a resposta"));
    out.println(F("  veio toda 00: o problema esta em MOSI/MISO ou no SCK."));
  } else if (allZero) {
    out.println(F("  o chip PROCESSOU o comando, mas a resposta veio toda 00."));
    out.println(F("  isso e o MISO: fio no pino errado, solto, ou trocado com o MOSI."));
  } else if (allOnes) {
    out.println(F("  resposta toda FF: MISO solto (so o pull-up do ESP32 aparece)."));
  } else {
    out.println(F("  o chip respondeu. Se a deteccao ainda reprova, o problema"));
    out.println(F("  nao e fiacao: veja LR2021_TCXO_VOLTAGE e a alimentacao sob carga."));
  }
  out.println(F("  de 'reset' pra religar o radio com o barramento limpo."));
  out.println(F("===================================================="));
}


namespace {

// Pinos que o header da DevKit v1 expõe e que podem receber uma linha de dados.
// Ficam de fora: os já usados (NSS/RST/BUSY/DIO9), o console UART (1/3), os
// strapping (0/2/12/15), a flash interna (6..11) e os só-entrada (34..39), que
// não servem de SCK nem de MOSI.
constexpr uint8_t kCandidates[] = {4, 5, 13, 14, 16, 17, 18, 19, 21, 22, 23, 27};

// Espera o BUSY liberar. Timeout curto: aqui ele é só uma cortesia — se o
// pino estiver errado, o laço não pode segurar a varredura inteira.
void waitBusy() {
  for (uint32_t t = micros(); digitalRead(PIN_LORA_BUSY) && micros() - t < 5000;) {
  }
}

// Uma tentativa: monta o SPI nesses três pinos e pergunta a versão pelo mesmo
// protocolo que o driver usa na detecção — comando de 16 bits numa transação,
// resposta na seguinte. O LR2021 responde 1.24 (0x01 0x18); o byte de status
// vem antes dos dados, então o par é procurado em qualquer posição.
bool tryPins(uint8_t sck, uint8_t mosi, uint8_t miso, uint8_t& major,
             uint8_t& minor) {
  SPI.end();
  pinMode(PIN_LORA_NSS, OUTPUT);
  digitalWrite(PIN_LORA_NSS, HIGH);
  pinMode(PIN_LORA_BUSY, INPUT);
  SPI.begin(sck, miso, mosi, PIN_LORA_NSS);
  SPI.beginTransaction(SPISettings(2000000UL, MSBFIRST, SPI_MODE0));

  waitBusy();
  digitalWrite(PIN_LORA_NSS, LOW);
  SPI.transfer(0x01);
  SPI.transfer(0x01);
  digitalWrite(PIN_LORA_NSS, HIGH);
  waitBusy();

  uint8_t rx[4] = {0};
  digitalWrite(PIN_LORA_NSS, LOW);
  for (uint8_t i = 0; i < sizeof(rx); ++i) rx[i] = SPI.transfer(0x00);
  digitalWrite(PIN_LORA_NSS, HIGH);
  SPI.endTransaction();
  SPI.end();

  for (uint8_t i = 0; i + 1 < sizeof(rx); ++i) {
    if (rx[i] == 0x01 && rx[i + 1] == 0x18) {
      major = rx[i];
      minor = rx[i + 1];
      return true;
    }
  }
  return false;
}

}  // namespace

void scan(Stream& out) {
  constexpr size_t n = sizeof(kCandidates);
  out.println();
  out.println(F("=== varredura de pinos SCK/MOSI/MISO ================"));
  out.printf("  NSS %d  RST %d  BUSY %d  (fixos, ja validados por 'wire')\n",
             PIN_LORA_NSS, PIN_LORA_RST, PIN_LORA_BUSY);
  out.printf("  candidatos: %u pinos -> %u combinacoes\n", (unsigned)n,
             (unsigned)(n * (n - 1) * (n - 2)));

  uint8_t hits = 0;
  for (size_t a = 0; a < n; ++a) {
    for (size_t b = 0; b < n; ++b) {
      if (b == a) continue;
      for (size_t c = 0; c < n; ++c) {
        if (c == a || c == b) continue;
        uint8_t major = 0, minor = 0;
        if (tryPins(kCandidates[a], kCandidates[b], kCandidates[c], major,
                    minor)) {
          out.printf("  ACHOU  SCK %d   MOSI %d   MISO %d   -> FW %u.%u\n",
                     kCandidates[a], kCandidates[b], kCandidates[c], major,
                     minor);
          ++hits;
        }
      }
    }
    // O laço demora alguns segundos; um ponto por pino de SCK mostra progresso.
    out.print('.');
  }
  SPI.end();

  out.println();
  if (hits) {
    out.println(F("  ponha esses tres em PIN_LORA_SCK/MOSI/MISO no platformio.ini"));
  } else {
    out.println(F("  nenhuma combinacao respondeu."));
    out.println(F("  entao pelo menos um dos tres fios nao esta em nenhum pino"));
    out.println(F("  do header — confira do lado do MODULO (pinos 3, 4 e 5)."));
  }
  out.println(F("  de 'reset' depois disto."));
  out.println(F("===================================================="));
}

}  // namespace wirecheck
