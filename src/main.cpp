/*
  LoRa2021 (Semtech LR2021) dual-band prototype - ESP32

  Flash the same firmware into two boards. They beacon at a fixed interval and
  print every frame received from the peer with RSSI/SNR. A serial console at
  115200 baud lets you retune band, frequency, power and modem parameters
  without reflashing - handy for comparing the sub-GHz and 2.4 GHz paths of the
  LR2021 side by side.

  Type `help` in the monitor for the command list.

  The same controls are available on a web panel: the board raises an access
  point (LoRa2021-<node>, senha lora2021) and serves data/ from LittleFS.
  Grave o sistema de arquivos com `pio run -t uploadfs`.
*/

#include <Arduino.h>
#include <Preferences.h>

#include "LoraLink.h"
#include "WebConfig.h"
#include "express.h"
#include "settings.h"
#include "radio_prefs.h"
#include "range_test.h"
#include "status_led.h"
#include "wire_check.h"
#include "board_pins.h"
#include "radio_profile.h"

namespace {

LoraLink radio;
WebConfig web;
Preferences prefs;

char nodeId[5] = "0000";
uint32_t txSeq = 0;

// --- runtime knobs -----------------------------------------------------------
bool beaconEnabled = true;
uint32_t beaconIntervalMs = 3000;

// Rede de casamento sub-GHz fechada na matriz de solda do módulo. Guardada na
// NVS porque é característica física da placa: ajusta uma vez e fica.
//
// Os módulos deste protótipo são 2.4G/433, então o PADRÃO é 433 — errar isso
// não dá erro nenhum no log: só some alcance, porque o sinal não sai da antena.
//
// É só o padrão de primeira gravação. `match 150|433|470|868|915` continua
// aceitando todas as redes, e 915 segue disponível pra quando houver módulo
// casado nela — o valor escolhido fica na NVS e sobrevive a regravação.
uint16_t matchedBand = 433;

void loadMatchedBand() {
  prefs.begin(settings::kNamespace, true);
  const uint16_t v = prefs.getUShort("match", 433);
  prefs.end();
  if (isMatchOption(v)) matchedBand = v;
}

void saveMatchedBand(uint16_t mhz) {
  if (!isMatchOption(mhz)) return;
  matchedBand = mhz;
  prefs.begin(settings::kNamespace, false);
  prefs.putUShort("match", mhz);
  prefs.end();
}

// Tensão do TCXO do módulo. Também mora na NVS: é característica da placa, e
// descobri-la é o primeiro passo de qualquer bring-up.
float tcxoVolts = LR2021_TCXO_VOLTAGE;

void loadTcxo() {
  prefs.begin(settings::kNamespace, true);
  tcxoVolts = prefs.getFloat("tcxo", LR2021_TCXO_VOLTAGE);
  prefs.end();
}

void saveTcxo(float v) {
  tcxoVolts = v;
  prefs.begin(settings::kNamespace, false);
  prefs.putFloat("tcxo", v);
  prefs.end();
}

// O painel lê o par por ponteiro (WebConfig::Hooks). O dono do estado é o
// módulo express; isto é só o espelho pra API.
uint8_t webPeerId = PEER_ELRS_2G4;

// --- statistics --------------------------------------------------------------
uint32_t txCount = 0;
uint32_t rxCount = 0;
float lastRssi = 0.0f;
float lastSnr = 0.0f;
uint32_t lastRttMs = 0;
uint32_t lastRxMs = 0;   // usado pelo painel pra dizer se o enlace está vivo
uint32_t lastElrsMs = 0; // último pacote ELRS que passou no CRC14
// Média móvel do intervalo entre pacotes ELRS válidos, e o maior já visto.
//
// A cadência não é escolha nossa: depende do transmissor do outro lado. Um
// ExpressLRS comercial CONECTADO espaça o SYNC — medido em bancada, 3,2 s entre
// pacotes, constante e sem falhas. O simulador do S3 manda a cada 250 ms. Uma
// janela fixa serve mal aos dois: 2 s fazia o LED piscar e parar contra o
// comercial, num enlace impecável.
uint32_t elrsGapAvgMs = 0;
uint32_t elrsGapMaxMs = 0;

// --- scheduling --------------------------------------------------------------
uint32_t nextBeaconAt = 0;
uint32_t nextTxSummaryAt = 0;

// Modo silencioso: só a telemetria ($T) e as respostas de comando saem.
//
// O console deste firmware foi escrito para gente ler no monitor. Ligado a um
// celular ele passa a ser um canal de dados, e aí todo aquele texto é banda
// gasta e CPU gasta — a 115200, uma linha de 90 caracteres custa ~8 ms, e o
// resumo mais o "TX done" de cada quadro competiam com a própria telemetria.
//
// O app manda `quiet on` ao conectar. Pelo monitor, `quiet off` devolve tudo.
bool quietMode = false;


// Em modo silencioso a telemetria acelera: é ela que vira a razão de existir da
// serial, e 5 s é lento demais para quem caminha marcando pontos.
uint32_t telemetryPeriodMs() { return quietMode ? 1000 : 5000; }
// Estado do simulador de transmissor ExpressLRS. O nonce é o que dá ao receptor
// um número de sequência — é dele que sai o LQ.
uint8_t elrsNonce = 0;
uint8_t elrsFhssIndex = 0;
// Até quando o simulador fica calado por ter ouvido outro transmissor.
uint32_t elrsHoldUntil = 0;
uint32_t pingSentAt = 0;
bool awaitingPong = false;
String pendingReply;
uint32_t pendingReplyAt = 0;

// O LED conta a mesma história dos contadores, mas de longe: apagado = não
// achei o módulo, aceso = rádio ok e esperando, piscando = quadro do par
// chegando. O estado é derivado a cada volta em vez de ser setado nos eventos —
// assim não existe caminho em que o LED fica mentindo por falta de um set.
void updateStatusLed() {
  statusled::Mode m;
  if (!radio.isReady()) {
    m = statusled::Mode::NoRadio;
  } else if (radio.sniffing()) {
    // Modo escuta: quem prova enlace é o pacote ELRS validado, não o quadro de
    // alcance — que aqui não existe. 2 s cobre a taxa de 50 Hz com folga, mesmo
    // contando que o canal de sync só é visitado de tempo em tempo.
    // Três intervalos médios: perder um pacote é normal, perder três não é.
    // Piso de 1 s pra não tremer com o simulador rápido; teto de 15 s pra a
    // queda do enlace ainda ser visível em tempo útil.
    // Antes do segundo pacote não há intervalo medido. Assumir um enlace lento
    // é o erro barato: no pior caso o LED demora a acusar uma queda; no outro
    // sentido ele piscaria e pararia logo no primeiro pacote de um enlace bom.
    uint32_t window = elrsGapAvgMs ? elrsGapAvgMs * 3 : 5000;
    if (window < 1000) window = 1000;
    if (window > 15000) window = 15000;
    const bool fresh = lastElrsMs != 0 && millis() - lastElrsMs < window;
    m = fresh ? statusled::Mode::Linked : statusled::Mode::Waiting;
  } else if (range::role() == range::Role::Rx) {
    m = range::linked() ? statusled::Mode::Linked : statusled::Mode::Waiting;
  } else {
    // No transmissor não há quadro chegando o tempo todo: o que prova enlace é
    // o relatório que o receptor devolve de tempos em tempos.
    const uint32_t at = range::lastAckMs();
    const bool fresh = at != 0 && millis() - at < 15000;
    m = fresh ? statusled::Mode::Linked : statusled::Mode::Waiting;
  }
  statusled::set(m);
  statusled::update();
}

// Intervalo real entre quadros de alcance.
//
// O valor de `rate` é um teto de cadência, não uma promessa. Em SF9 / 125 kHz —
// a configuração de 433 MHz — um quadro de 48 bytes ocupa cerca de 400 ms de
// ar; pedir um a cada 250 ms, como em 2.4 GHz, faz o transmissor pisar no
// próprio rabo. Foi o que a bancada mostrou ao trocar de banda: LQ caiu pra 90%
// e nenhum relatório do receptor voltava, porque o transmissor quase nunca
// estava escutando.
//
// O fator 4 deixa três quartos do tempo com o rádio em RX — onde o relatório
// cabe — e de quebra segura o ciclo de trabalho em 25%, o que importa em 433,
// onde há limite regulatório de ocupação em várias regiões.
uint32_t rangeIntervalMs() {
  const uint32_t floorMs = radio.timeOnAirMs(LoraLink::frameLen()) * 4;
  const uint32_t asked = range::intervalMs();
  return asked > floorMs ? asked : floorMs;
}

// Varre as taxas de pacote do ExpressLRS 2.4 GHz procurando a do transmissor.
//
// A tabela vem de elrs/ExpressLRS-v3/src/src/common.cpp: todas usam BW 800 kHz
// e interleaver LONGO; o que muda entre elas é o fator de espalhamento. Sentar
// na taxa errada não dá erro nenhum — simplesmente não demodula, e a tela fica
// idêntica a "não há transmissor no ar".
//
// O critério é o contador de pacotes CRUS, não o de válidos: o CRC14 depende da
// frase de binding, e aqui a pergunta é anterior a essa — o rádio consegue
// demodular alguma coisa nesta modulação?
void scanElrsRates() {
  struct Rate { const char* name; uint8_t sf; uint8_t preamble; };
  static const Rate rates[] = {
      {"500 Hz", 5, 12}, {"333 Hz 8ch", 5, 12}, {"250 Hz", 6, 14},
      {"150 Hz", 7, 12}, {"100 Hz 8ch", 7, 12}, {"50 Hz", 8, 12},
  };

  Serial.println();
  Serial.println(F("=== varredura de taxas ExpressLRS 2.4 GHz =========="));
  Serial.println(F("  2441,4 MHz - canal de sync - BW 812,5 kHz - CR 4/8 LI"));
  Serial.println(F("  4 s por taxa; deixe o transmissor ligado e proximo"));

  const uint8_t before = express::peer();
  uint8_t best = 0;
  uint32_t bestSeen = 0;

  for (const Rate& r : rates) {
    radio.applyModem(2441.4f, 812.5f, r.sf, 8);
    radio.setSniff(8, r.preamble, express::iqInverted(), true);

    const uint32_t start = express::rawCount();
    const uint32_t until = millis() + 4000;
    while (millis() < until) {
      LoraLink::Packet pkt;
      if (radio.poll(pkt) && pkt.len > 0) {
        String desc;
        express::describe(pkt.raw, pkt.len, desc);
      }
    }
    const uint32_t seen = express::rawCount() - start;
    Serial.printf("  SF%u  %-11s -> %lu pacotes\n", r.sf, r.name,
                  static_cast<unsigned long>(seen));
    if (seen > bestSeen) { bestSeen = seen; best = r.sf; }
  }

  Serial.println(F("  --- conclusao ---"));
  if (bestSeen == 0) {
    Serial.println(F("  nada demodulado em nenhuma taxa."));
    Serial.println(F("  o transmissor esta transmitindo? antena na porta 2.4G?"));
    Serial.println(F("  lembre que o ELRS salta 80 canais: so o de sync e ouvido aqui."));
  } else {
    Serial.printf("  melhor: SF%u com %lu pacotes\n", best,
                  static_cast<unsigned long>(bestSeen));
    Serial.println(F("  se o CRC nao validar nessa taxa, o que falta e a FRASE"));
    Serial.println(F("  de binding — ela decide o UID, o IQ e a semente do CRC."));
  }
  Serial.println(F("===================================================="));

  express::applyPeer(radio, static_cast<PeerId>(before));
}

// Linha de telemetria para consumo por programa, nao por gente.
//
// O resumo humano ("LQ 100% | RSSI -40.0 dBm | ...") e otimo no monitor e
// pessimo como contrato: qualquer ajuste de texto quebra quem estiver
// parseando. Esta linha tem prefixo fixo, pares chave=valor e ordem estavel, e
// convive com o resto do log — o leitor ignora tudo que nao comeca com "$T ".
//
// E o que o app de alcance le pela serial USB do celular.
void printTelemetry() {
  const LoraLink::State& st = radio.state();
  Serial.printf("$T t=%lu link=%d rssi=%.1f snr=%.1f lq=%u rx=%lu lost=%lu"
                " freq=%.3f band=%s sf=%u bw=%.2f pwr=%d role=%s\n",
       static_cast<unsigned long>(millis()),
       radio.sniffing() ? (millis() - lastElrsMs < 3000 ? 1 : 0)
                        : (range::linked() ? 1 : 0),
       lastRssi, lastSnr, range::lq(),
       static_cast<unsigned long>(range::received()),
       static_cast<unsigned long>(range::lost()),
       st.frequencyMHz, bandProfile(st.band).alias,
       st.spreadingFactor, st.bandwidthKHz, st.powerDbm,
       range::role() == range::Role::Tx ? "tx" : "rx");
}

void deriveNodeId() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(nodeId, sizeof(nodeId), "%02X%02X", static_cast<uint8_t>(mac >> 8),
           static_cast<uint8_t>(mac));
}

void printBanner() {
  const LoraLink::State& s = radio.state();
  const BandProfile& p = bandProfile(s.band);

  Serial.println();
  Serial.println(F("=== LoRa2021 / LR2021 dual-band node ==============="));
  Serial.printf("  node id      : %s\n", nodeId);
  Serial.printf("  band         : %s (%s)\n", p.name, p.note);
  Serial.printf("  frequency    : %.3f MHz  [%s path]\n", s.frequencyMHz,
                isHighFreq(s.frequencyMHz) ? "HF 2.4G/S" : "LF sub-GHz");
  Serial.printf("  modem        : SF%u  BW %.2f kHz  CR 4/%u  sync 0x%02X\n",
                s.spreadingFactor, s.bandwidthKHz, s.codingRate, s.syncWord);
  Serial.printf("  tx power     : %d dBm\n", s.powerDbm);
  Serial.printf("  rede casada  : %u MHz%s\n", matchedBand,
                isMismatched(matchedBand, s.frequencyMHz)
                    ? "   <<< NAO BATE com a frequencia atual" : "");
  Serial.printf("  radio        : %s\n",
                radio.isReady() ? "pronto"
                                : LoraLink::errorName(radio.lastInitState()));
  Serial.println(F("  --- pinos (ESP32) ---"));
  Serial.printf("  SCK %d   MISO %d   MOSI %d   NSS %d\n",
                PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);
  Serial.printf("  RST %d   BUSY %d   IRQ %d  (= DIO%d do modulo)\n",
                PIN_LORA_RST, PIN_LORA_BUSY, PIN_LORA_IRQ, LR2021_IRQ_DIO_NUM);
  Serial.printf("  time on air  : %lu ms por quadro de %u B\n",
                static_cast<unsigned long>(radio.timeOnAirMs(LoraLink::frameLen())),
                LoraLink::frameLen());
  Serial.printf("  cadencia     : %lu ms entre quadros%s\n",
                static_cast<unsigned long>(rangeIntervalMs()),
                rangeIntervalMs() > range::intervalMs()
                    ? "   (limitada pelo tempo no ar)" : "");
  radioprefs::print(Serial);
  Serial.printf("  frase bind   : \"%s\"\n", express::phrase());
  Serial.printf("  UID          : %s   (IQ %s)\n", express::uidText().c_str(),
                express::iqInverted() ? "invertido" : "normal");
  const PeerProfile& pp = express::peerInfo();
  Serial.printf("  par de teste : %s%s\n", pp.name,
                pp.decodes ? "" : "   (modo escuta: nao decodifica ELRS)");
  Serial.printf("               %s\n", pp.note);
  Serial.printf("  beacon       : %s every %lu ms\n",
                beaconEnabled ? "on" : "off",
                static_cast<unsigned long>(beaconIntervalMs));
  Serial.println(F("  type 'help' for commands"));
  Serial.println(F("===================================================="));
}

void printHelp() {
  Serial.println(F("\ncommands:"));
  Serial.println(F("  help                 this list"));
  Serial.println(F("  info                 current radio configuration"));
  Serial.println(F("  stats                packet counters"));
  Serial.println(F("  band <433|470|868|915|sband|2g4>"));
  Serial.println(F("  freq <MHz>           150-1090 | 1900-2200 | 2400-2500"));
  Serial.println(F("  pwr <dBm>            LF -9..22, HF -19..12 (auto clamped)"));
  Serial.println(F("  sf <5..12>"));
  Serial.println(F("  bw <kHz>             31.25 41.67 62.5 83.33 100 125"));
  Serial.println(F("                       203.125 250 406.25 500 812.5 1000"));
  Serial.println(F("  cr <4..8>            coding rate 4/N"));
  Serial.println(F("  peer <bancada2g4|bancada433|bancada|elrs2g4|elrs900>"));
  Serial.println(F("                       o que esta do outro lado do enlace"));
  Serial.println(F("  tcxo scan            testa todas as tensoes e fixa a que funcionar"));
  Serial.println(F("  tcxo <volts>         0 | 1.6 | 1.7 | 1.8 | 2.2 | 2.4 | 2.7 | 3.0 | 3.3"));
  Serial.println(F("  match <150|433|470|868|915>"));
  Serial.println(F("                       rede de casamento soldada no modulo"));
  Serial.println(F("  send <text>          transmit one frame"));
  Serial.println(F("  ping                 round-trip test against the peer"));
  Serial.println(F("  beacon <on|off|ms>   periodic broadcast"));
  Serial.println(F("  role <rx|tx>         papel no teste de alcance (grava na NVS)"));
  Serial.println(F("  rate <ms>            intervalo entre quadros de alcance"));
  Serial.println(F("  tel                  uma linha de telemetria ($T chave=valor)"));
  Serial.println(F("  quiet <on|off>       so telemetria, pra quando um app estiver lendo"));
  Serial.println(F("  rssi                 piso de ruido do canal e margem do enlace"));
  Serial.println(F("  wire                 teste eletrico dos 7 fios do modulo"));
  Serial.println(F("  scan                 procura SCK/MOSI/MISO nos pinos do header"));
  Serial.println(F("  elrsscan             procura a taxa do transmissor ELRS 2.4 GHz"));
  Serial.println(F("  reset                reboot the ESP32"));
}

void printStats() {
  if (radio.sniffing()) {
    Serial.printf(
        "  escuta ELRS: %lu pacotes demodulados, %lu passaram no CRC14\n",
        static_cast<unsigned long>(express::rawCount()),
        static_cast<unsigned long>(express::validCount()));
    if (elrsGapAvgMs) {
      Serial.printf(
          "  cadencia: %lu ms entre pacotes (maior %lu ms) -> LED espera %lu ms\n",
          static_cast<unsigned long>(elrsGapAvgMs),
          static_cast<unsigned long>(elrsGapMaxMs),
          static_cast<unsigned long>(
              elrsGapAvgMs * 3 < 1000 ? 1000
              : elrsGapAvgMs * 3 > 15000 ? 15000
                                         : elrsGapAvgMs * 3));
      Serial.println(F("  um ELRS conectado espaca o SYNC (~3 s): nao e perda"));
    }
    if (express::rawCount() > 0 && express::validCount() == 0) {
      Serial.println(F("  -> ha sinal no ar e a modulacao bate, mas o CRC reprova"));
      Serial.println(F("     tudo: e a FRASE de binding que nao e a do transmissor"));
    }
  }
  if (radio.transmitTimeouts()) {
    Serial.printf("  ATENCAO: %lu transmissoes fechadas por watchdog (IRQ perdido)\n",
                  static_cast<unsigned long>(radio.transmitTimeouts()));
  }
  Serial.printf("\n  tx=%lu  rx=%lu  rx_err=%lu  last RSSI=%.1f dBm  SNR=%.1f dB",
                static_cast<unsigned long>(txCount),
                static_cast<unsigned long>(rxCount),
                static_cast<unsigned long>(radio.receiveErrors()), lastRssi,
                lastSnr);
  if (lastRttMs) {
    Serial.printf("  last ping RTT=%lu ms", static_cast<unsigned long>(lastRttMs));
  }
  Serial.println();
}

void report(const char* what, int16_t state) {
  if (state == LoraLink::ERR_NONE) {
    Serial.printf("  %s ok\n", what);
  } else {
    Serial.printf("  %s FAILED: %s (%d)\n", what, LoraLink::errorName(state),
                  state);
  }
}

// Frame layout: "<srcId>|<seq>|<kind>|<payload>"
String buildFrame(const char* kind, const String& payload) {
  String frame(nodeId);
  frame += '|';
  frame += String(txSeq++);
  frame += '|';
  frame += kind;
  frame += '|';
  frame += payload;
  return frame;
}

void transmit(const char* kind, const String& payload) {
  String frame = buildFrame(kind, payload);
  // Os quadros de alcance saem 4 vezes por segundo. Imprimir cada um enterra
  // qualquer outra linha do console — inclusive o relatório do receptor, que é
  // justamente o que se quer ler durante o teste. O resumo periódico do loop
  // cobre o que interessa.
  const bool quiet = strcmp(kind, "RNG") == 0;
  int16_t state = radio.send(frame);
  if (state == LoraLink::ERR_NONE) {
    txCount++;
    if (!quiet) {
      Serial.printf("  TX -> %s\n", frame.c_str());
      web.logLine("tx", String("-> ") + frame);
    }
  } else {
    Serial.printf("  TX FAILED: %s (%d)\n", LoraLink::errorName(state), state);
    web.logLine("err", String("envio falhou: ") + LoraLink::errorName(state));
  }
}

void handleFrame(const LoraLink::Packet& packet) {
  lastRssi = packet.rssi;
  lastSnr = packet.snr;
  lastRxMs = millis();

  if (packet.len > 0) {
    // Modo escuta: bytes crus do ar. Quem valida e formata é o módulo do
    // ExpressLRS — sem o CRC em software o ruído entraria como pacote, porque
    // nesse modo o CRC de hardware está desligado.
    String desc;
    if (!express::describe(packet.raw, packet.len, desc)) {
      // Reprovou no CRC14. Mostrar um a cada 16 é o suficiente pra provar que
      // há sinal audível sem inundar o console — e essa prova é o que separa
      // "não há transmissor" de "a frase de binding está errada".
      if ((express::rawCount() % 16) == 0) {
        String raw;
        char b[4];
        for (uint8_t i = 0; i < packet.len; i++) {
          snprintf(b, sizeof(b), "%02X ", packet.raw[i]);
          raw += b;
        }
        Serial.printf("  ELRS? %s [CRC ruim]  RSSI %6.1f dBm\n", raw.c_str(),
                      packet.rssi);
      }
      return;
    }

    // Média móvel simples (1/4 do novo valor) antes de atualizar o timestamp:
    // é preciso do intervalo, não do instante.
    if (lastElrsMs != 0) {
      const uint32_t gap = millis() - lastElrsMs;
      elrsGapAvgMs = elrsGapAvgMs ? (elrsGapAvgMs * 3 + gap) / 4 : gap;
      if (gap > elrsGapMaxMs) elrsGapMaxMs = gap;
    }
    lastElrsMs = millis();
    rxCount++;
    // O nonce faz papel de número de sequência. Contra o simulador ele
    // incrementa de um em um, e o LQ é exato; contra um transmissor comercial
    // ele avança por PACOTE (50/s) e só os SYNC chegam aqui, então o LQ sai
    // pessimista de propósito — nesse caso olhe RSSI, SNR e a contagem.
    range::onFrame(packet.raw[2], packet.rssi, packet.snr);

    // Em meia-duplex ninguém escuta o próprio pacote. Então um SYNC válido
    // chegando enquanto ESTA placa é o transmissor só pode vir de outro rádio —
    // e ele usa o mesmo UID e o mesmo canal de sync que nós.
    //
    // Dois transmissores ali é o que faz o transmissor comercial "transmitir e
    // parar": nossos pacotes caem em cima dos dele. Pior: um receptor pareado
    // com ele veria SYNC nosso como se fosse dele. Ceder o canal é a única
    // conduta defensável, e é automática pra não depender de alguém lembrar.
    if (range::role() == range::Role::Tx) {
      const bool first = elrsHoldUntil == 0;
      elrsHoldUntil = millis() + 5000;
      if (first) {
        Serial.println(F("  OUTRO TRANSMISSOR NO AR — simulador calado"));
        Serial.println(F("  (mesmo UID e mesmo canal: nossos pacotes atropelariam"));
        Serial.println(F("   os dele, e um receptor pareado nao distinguiria os dois)"));
        web.logLine("err", "outro transmissor no ar — simulador calado");
      }
    }
    if (!quietMode) Serial.printf("  ELRS #%lu  %s  RSSI %6.1f dBm  SNR %5.1f dB\n",
                  static_cast<unsigned long>(express::validCount()),
                  desc.c_str(), packet.rssi, packet.snr);
    web.logLine("rx", "ELRS " + desc + "  " + String(packet.rssi, 1) + " dBm");
    return;
  }

  rxCount++;

  // "<src>|<seq>|<kind>|<payload>"
  const int sep1 = packet.text.indexOf('|');
  const int sep2 = packet.text.indexOf('|', sep1 + 1);
  const int sep3 = packet.text.indexOf('|', sep2 + 1);
  const String kind =
      (sep1 < 0 || sep2 < 0 || sep3 < 0)
          ? String()
          : packet.text.substring(sep2 + 1, sep3);

  // Quadro a quadro, 4 vezes por segundo, o console vira cascata e o resumo
  // periódico — que é o que se lê durante o teste — não sobrevive na tela. O
  // parse vem antes do print só pra poder tomar esta decisão.
  if (kind != "RNG" && !quietMode) {
    Serial.printf("  RX <- %-48s  RSSI %6.1f dBm  SNR %5.1f dB\n",
                  packet.text.c_str(), packet.rssi, packet.snr);
    web.logLine("rx", "<- " + packet.text + "  [" + String(packet.rssi, 1) +
                          " dBm / " + String(packet.snr, 1) + " dB]");
  }

  if (sep1 < 0 || sep2 < 0 || sep3 < 0) return;

  const String src = packet.text.substring(0, sep1);

  if (src == nodeId) return;  // our own frame looped back somehow

  if (kind == "RNG") {
    // Quadro do transmissor. O número de sequência é o que permite contar os
    // que não chegaram — por isso ele vem do campo <seq> do próprio protocolo,
    // e não de um contador local.
    const uint32_t seq = packet.text.substring(sep1 + 1, sep2).toInt();
    range::onFrame(seq, packet.rssi, packet.snr);
    if (range::ackDue()) {
      // O relatório sai LOGO depois do quadro que acabou de chegar.
      //
      // A tentação é mandá-lo no meio da janela entre dois quadros, e por um
      // tempo foi o que este código fez. Em 2.4 GHz funcionava; em 433 MHz,
      // não: lá o quadro ocupa ~400 ms de ar, e o relatório tem o mesmo
      // tamanho. Começando na metade de uma janela de 1,6 s, ele terminava em
      // cima da transmissão seguinte, e o transmissor — ocupado transmitindo —
      // não ouvia nada.
      //
      // Um atraso curto e fixo não tem esse problema: o transmissor acabou de
      // largar o ar e, com o fallback do chip em FS, volta pra escuta em
      // microssegundos. 30 ms é folga de sobra pra ele tratar a interrupção de
      // fim de transmissão, e o relatório inteiro cabe antes do próximo quadro
      // em qualquer modulação.
      pendingReply = src;
      pendingReplyAt = millis() + 30;
    }
    return;
  }

  if (kind == "RNGA") {
    // Relatório do receptor chegando de volta no transmissor.
    const String payload = packet.text.substring(sep3 + 1);
    range::onAck(payload, packet.rssi, packet.snr);
    Serial.printf("  RX relata: %s   (retorno %.1f dBm / %.1f dB)\n",
                  payload.c_str(), packet.rssi, packet.snr);
    web.logLine("rx", "RX relata " + payload);
    return;
  }

  if (kind == "PING") {
    // Give the peer a moment to switch back to RX before answering.
    pendingReply = src;
    pendingReplyAt = millis() + 50;
  } else if (kind == "PONG" && awaitingPong) {
    awaitingPong = false;
    lastRttMs = millis() - pingSentAt;
    Serial.printf("  ping round-trip: %lu ms\n",
                  static_cast<unsigned long>(lastRttMs));
  }
}

void handleCommand(String line) {
  line.trim();
  if (line.isEmpty()) return;

  const int space = line.indexOf(' ');
  const String cmd = (space < 0) ? line : line.substring(0, space);
  const String arg = (space < 0) ? String() : line.substring(space + 1);

  if (cmd.equalsIgnoreCase("help")) {
    printHelp();

  } else if (cmd.equalsIgnoreCase("info")) {
    printBanner();

  } else if (cmd.equalsIgnoreCase("stats")) {
    printStats();
    range::printStats(Serial);

  } else if (cmd.equalsIgnoreCase("role")) {
    range::Role r;
    if (!range::roleFromToken(arg, r)) {
      Serial.println(F("  uso: role rx | tx"));
      return;
    }
    range::setRole(r);
    Serial.printf("  papel agora: %s\n", range::roleName());

  } else if (cmd.equalsIgnoreCase("rate")) {
    range::setIntervalMs(arg.toInt());
    Serial.printf("  intervalo: %lu ms\n",
                  static_cast<unsigned long>(range::intervalMs()));

  } else if (cmd.equalsIgnoreCase("band")) {
    BandId band;
    if (!bandFromAlias(arg, band)) {
      Serial.println(F("  unknown band (433 470 868 915 sband 2g4)"));
      return;
    }
    report("band change", radio.applyBand(band));
    // Grava, igual ao painel: o console e a tela mexem na MESMA configuracao,
    // e discordarem sobre o que sobrevive ao reset seria pior que nao gravar.
    radioprefs::save(radio.state());
    printBanner();

  } else if (cmd.equalsIgnoreCase("freq")) {
    report("set frequency", radio.setFrequency(arg.toFloat()));
    radioprefs::save(radio.state());

  } else if (cmd.equalsIgnoreCase("pwr")) {
    report("set power", radio.setPower(static_cast<int8_t>(arg.toInt())));
    radioprefs::save(radio.state());
    Serial.printf("  tx power now %d dBm\n", radio.state().powerDbm);

  } else if (cmd.equalsIgnoreCase("sf")) {
    report("set spreading factor",
           radio.setSpreadingFactor(static_cast<uint8_t>(arg.toInt())));
    radioprefs::save(radio.state());

  } else if (cmd.equalsIgnoreCase("bw")) {
    report("set bandwidth", radio.setBandwidth(arg.toFloat()));
    radioprefs::save(radio.state());

  } else if (cmd.equalsIgnoreCase("cr")) {
    report("set coding rate",
           radio.setCodingRate(static_cast<uint8_t>(arg.toInt())));
    radioprefs::save(radio.state());

  } else if (cmd.equalsIgnoreCase("send")) {
    transmit("DATA", arg.isEmpty() ? String("hello") : arg);

  } else if (cmd.equalsIgnoreCase("ping")) {
    pingSentAt = millis();
    awaitingPong = true;
    transmit("PING", String(pingSentAt));

  } else if (cmd.equalsIgnoreCase("beacon")) {
    if (arg.equalsIgnoreCase("on")) {
      beaconEnabled = true;
    } else if (arg.equalsIgnoreCase("off")) {
      beaconEnabled = false;
    } else if (arg.toInt() > 0) {
      beaconIntervalMs = static_cast<uint32_t>(arg.toInt());
      beaconEnabled = true;
    }
    Serial.printf("  beacon %s, interval %lu ms\n", beaconEnabled ? "on" : "off",
                  static_cast<unsigned long>(beaconIntervalMs));

  } else if (cmd.equalsIgnoreCase("match")) {
    const uint16_t m = static_cast<uint16_t>(arg.toInt());
    if (!isMatchOption(m)) {
      Serial.println(F("  use: match 150|433|470|868|915"));
      return;
    }
    saveMatchedBand(m);
    Serial.printf("  rede de casamento: %u MHz\n", m);
    if (isMismatched(m, radio.state().frequencyMHz)) {
      Serial.println(F("  AVISO: a frequencia atual esta fora dessa rede"));
    }

  } else if (cmd.equalsIgnoreCase("peer")) {
    PeerId pid;
    if (!express::peerFromToken(arg, pid)) {
      Serial.println(F("  use: peer bancada | elrs2g4 | elrs900"));
      return;
    }
    const PeerProfile& pp = peerProfile(pid);
    // O par traz a propria banda: manter um ajuste manual gravado por cima
    // deixaria duas coisas mandando na mesma frequencia.
    radioprefs::clear();
    report("par de teste", express::applyPeer(radio, pid));
    Serial.printf("  %s\n", pp.name);
    Serial.printf("  %s\n", pp.note);
    if (!pp.decodes) {
      Serial.println(F("  MODO ESCUTA: este firmware nao decodifica ExpressLRS."));
      Serial.println(F("  'CRC ruim' subindo = o transmissor esta audivel."));
    }

  } else if (cmd.equalsIgnoreCase("tcxo")) {
    if (arg.equalsIgnoreCase("scan")) {
      // A tensão certa é característica do módulo e o sintoma de estar errada
      // (SPI responde, calibração falha) não aponta pra causa. Então testa
      // todas e mostra qual fecha.
      Serial.println(F("\n  varrendo tensões de TCXO..."));
      float achou = -1.0f;
      for (uint8_t i = 0; i < LoraLink::kTcxoCount; i++) {
        const float v = LoraLink::kTcxoOptions[i];
        const bool ok = radio.restart(v);
        Serial.printf("   %4.1f V  ->  %s\n", v,
                      ok ? "OK <<<<<<" : LoraLink::errorName(radio.lastInitState()));
        if (ok && achou < 0) achou = v;
      }
      if (achou >= 0) {
        radio.restart(achou);
        saveTcxo(achou);
        Serial.printf("  usando %.1f V (gravado na NVS)\n", achou);
      } else {
        Serial.println(F("  nenhuma funcionou — verifique alimentação e SPI"));
      }
      return;
    }
    const float v = arg.toFloat();
    const bool ok = radio.restart(v);
    saveTcxo(v);
    Serial.printf("  TCXO %.1f V: %s\n", v,
                  ok ? "OK" : LoraLink::errorName(radio.lastInitState()));

  } else if (cmd.equalsIgnoreCase("quiet")) {
    if (arg.equalsIgnoreCase("on") || arg == "1") {
      quietMode = true;
      Serial.println(F("  quiet on — so telemetria $T, a cada 1 s"));
    } else if (arg.equalsIgnoreCase("off") || arg == "0") {
      quietMode = false;
      Serial.println(F("  quiet off — log completo, telemetria a cada 5 s"));
    } else {
      Serial.printf("  quiet %s   (uso: quiet on | off)\n",
                    quietMode ? "on" : "off");
    }

  } else if (cmd.equalsIgnoreCase("tel")) {
    printTelemetry();

  } else if (cmd.equalsIgnoreCase("rssi")) {
    // Amostra o piso várias vezes: o ruído oscila, e uma leitura só engana.
    // Guarda o mínimo além da média — é o mínimo que representa o canal calmo,
    // enquanto a média já inclui as rajadas de quem mais estiver no ar.
    float sum = 0.0f, worst = -999.0f, best = 999.0f;
    const uint8_t kSamples = 32;
    for (uint8_t i = 0; i < kSamples; ++i) {
      const float v = radio.noiseFloor();
      sum += v;
      if (v > worst) worst = v;
      if (v < best) best = v;
      delay(5);
    }
    const float avg = sum / kSamples;
    // O PISO e o MINIMO, nao a media.
    //
    // A amostragem dura ~160 ms e o par transmite a cada 1,6 s, entao parte das
    // leituras pega o proprio sinal do enlace em vez do silencio. Medido nesta
    // bancada: no receptor a media deu -86 dBm com maximo de -35, enquanto o
    // minimo (-115) batia com o piso limpo lido no transmissor (-113). A media
    // mede "canal ocupado por nos"; o minimo mede o canal.
    Serial.printf("  piso de ruido : %.1f dBm  (media %.1f / pico %.1f)\n",
                  best, avg, worst);
    if (worst - best > 20.0f) {
      Serial.println(F("  (a excursao ate o pico e o proprio par transmitindo)"));
    }
    if (lastRssi != 0.0f) {
      Serial.printf("  ultimo pacote : %.1f dBm  SNR %.1f dB\n", lastRssi, lastSnr);
      Serial.printf("  margem        : %.1f dB acima do piso\n", lastRssi - best);
    } else {
      Serial.println(F("  ultimo pacote : nenhum ainda"));
    }
    // O LR2021 aceita ate +10 dBm na entrada; perto disso o receptor comprime e
    // o RSSI deixa de servir pra comparar enlaces.
    if (lastRssi > -20.0f) {
      Serial.println(F("  ATENCAO: sinal muito forte, receptor pode estar comprimido"));
      Serial.println(F("           afaste as placas ou reduza a potencia com 'pwr'"));
    }

  } else if (cmd.equalsIgnoreCase("wire")) {
    wirecheck::run(Serial);

  } else if (cmd.equalsIgnoreCase("scan")) {
    wirecheck::scan(Serial);

  } else if (cmd.equalsIgnoreCase("elrsscan")) {
    scanElrsRates();

  } else if (cmd.equalsIgnoreCase("reset")) {
    ESP.restart();

  } else {
    Serial.printf("  unknown command '%s' - try 'help'\n", cmd.c_str());
  }
}

void pollSerial() {
  static String line;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      handleCommand(line);
      line = "";
    } else if (line.length() < 200) {
      line += c;
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  const uint32_t deadline = millis() + 2000;
  while (!Serial && millis() < deadline) {
    delay(10);
  }

  statusled::begin();
  deriveNodeId();
  settings::begin();
  loadMatchedBand();
  radioprefs::begin();
  loadTcxo();
  express::begin();
  range::begin();
  webPeerId = static_cast<uint8_t>(express::peer());

  Serial.println(F("\n[LR2021] initializing radio ..."));
  const bool radioOk = radio.begin(static_cast<BandId>(DEFAULT_BAND_INDEX), tcxoVolts);
  if (!radioOk) {
    const int16_t state = radio.lastInitState();
    Serial.printf("[LR2021] FALHOU: %s (%d)\n", LoraLink::errorName(state), state);
    Serial.println(F("  verifique: 3V3, fiação SPI, NRST/BUSY,"));
    Serial.println(F("             LR2021_TCXO_VOLTAGE (1.6 com TCXO, 0 com cristal),"));
    Serial.println(F("             LR2021_IRQ_DIO_NUM (o módulo traz DIO7/8/9)"));
    // NÃO trava aqui. O painel é justamente a ferramenta de diagnóstico: antes
    // este caminho entrava num while(true) e o WiFi nunca subia, deixando a
    // placa muda exatamente quando havia algo pra investigar.
    Serial.println(F("  seguindo assim mesmo — o painel sobe pra diagnóstico"));
    // Chip mudo é quase sempre fiação. Rodar o teste aqui poupa a viagem de
    // abrir o monitor e digitar `wire`.
    if (state == LoraLink::ERR_CHIP_NOT_FOUND) wirecheck::run(Serial);
  }

  // Reaplica o par salvo: o rádio subiu com o preset de banda, não com a
  // camada física do par (que pode ser modo escuta).
  if (radioOk) express::applyPeer(radio, express::peer());

  // E, por cima dele, o ajuste feito no painel. Esta é a linha que faz a
  // escolha de banda sobreviver ao reset: sem ela o boot terminava sempre na
  // banda do par, e o painel voltava a mostrar outra frequência da que o
  // operador tinha deixado gravada.
  if (radioOk) radioprefs::apply(radio);

  printBanner();

  WebConfig::Hooks hooks;
  hooks.nodeId = nodeId;
  // O papel é lido uma vez, aqui: o nome do access point é fixado no begin() do
  // WiFi, então trocar de papel com `role` só muda o SSID no próximo boot.
  hooks.roleTag = range::role() == range::Role::Tx ? "TX" : "RX";
  hooks.beaconEnabled = &beaconEnabled;
  hooks.beaconIntervalMs = &beaconIntervalMs;
  hooks.txCount = &txCount;
  hooks.rxCount = &rxCount;
  hooks.lastRssi = &lastRssi;
  hooks.lastSnr = &lastSnr;
  hooks.lastRttMs = &lastRttMs;
  hooks.lastRxMs = &lastRxMs;
  // O papel decide o que "qualidade de enlace" significa.
  //
  // Só o RECEPTOR conta quadros perdidos pela numeração — é ele que sabe o que
  // faltou. No transmissor esse contador seria sempre 100%, porque ninguém
  // reporta perda para quem transmite. Devolver 255 ali é dizer "sem medida"
  // em vez de exibir um 100% que não mede nada.
  hooks.linkQuality = []() -> uint8_t {
    return range::role() == range::Role::Rx ? range::lq() : 255;
  };
  hooks.lostFrames = []() -> uint32_t {
    return range::role() == range::Role::Rx ? range::lost() : 0;
  };
  hooks.matchedBand = &matchedBand;
  hooks.peer = &webPeerId;
  hooks.onRadioChanged = [] { radioprefs::save(radio.state()); };
  hooks.setPeer = [](uint8_t v) {
    // Ver o comando `peer` do console: o par apaga o ajuste manual.
    radioprefs::clear();
    express::applyPeer(radio, static_cast<PeerId>(v));
    webPeerId = v;
    const PeerProfile& pp = peerProfile(static_cast<PeerId>(v));
    web.logLine("sys", String("par de teste: ") + pp.name);
    if (!pp.decodes) {
      web.logLine("sys", "modo escuta — este firmware nao decodifica ELRS");
    }
  };
  hooks.setMatchedBand = [](uint16_t mhz) {
    saveMatchedBand(mhz);
    web.logLine("sys", String("rede de casamento: ") + mhz + " MHz");
  };
  hooks.phrase = [] { return String(express::phrase()); };
  hooks.uidText = [] { return express::uidText(); };
  hooks.setPhrase = [](const String& text) {
    if (!express::setPhrase(text)) return false;
    // A frase mudou o UID, e o UID manda na inversão de IQ. Reaplicar o par é
    // o que faz o rádio pegar a inversão nova — sem isso a mudança só apareceria
    // no próximo boot, e no meio-tempo o painel mostraria um UID que o rádio
    // não está usando.
    express::applyPeer(radio, express::peer());
    web.logLine("sys", "frase de binding: " + text);
    web.logLine("sys", "UID " + express::uidText() + "  (IQ " +
                           (express::iqInverted() ? "invertido" : "normal") + ")");
    return true;
  };
  hooks.sendText = [](const String& text) { transmit("DATA", text); };
  hooks.sendPing = [] {
    pingSentAt = millis();
    awaitingPong = true;
    transmit("PING", String(pingSentAt));
  };
  web.begin(radio, hooks);


  Serial.println();
  Serial.println(F("=== WiFi ============================================"));
  Serial.printf("  ponto de acesso : %s\n", web.ssid().c_str());
  Serial.printf("  senha           : lora2021\n");
  Serial.printf("  painel          : http://%s\n", web.ip().toString().c_str());
  Serial.println(F("  (se a página não abrir: 'pio run -t uploadfs')"));
  Serial.printf("  ATENCAO: sem nenhum acesso em %lu s o WiFi se DESLIGA\n",
                static_cast<unsigned long>(WebConfig::kApGraceMs / 1000));
  Serial.println(F("           (o radio de 2,4 GHz do WiFi atrapalha o LoRa em 2G4)"));
  Serial.println(F("           volta com 'reset' ou religando a placa"));
  Serial.println(F("====================================================="));

  if (!radioOk) {
    web.logLine("err", String("rádio não inicializou: ") +
                           LoraLink::errorName(radio.lastInitState()));
  }

  nextBeaconAt = millis() + 1000;
}

void loop() {
  pollSerial();

  web.loop();

  LoraLink::Packet packet;
  if (radio.poll(packet)) {
    handleFrame(packet);
  }

  if (radio.transmitFinished()) {
    // Nada a imprimir: a 4 quadros por segundo esta linha era a mais ruidosa do
    // console, e o total de transmissões já aparece no resumo periódico.
  }

  const uint32_t now = millis();

  if (pendingReplyAt && now >= pendingReplyAt && !radio.isTransmitting()) {
    pendingReplyAt = 0;
    // No papel de receptor o que se devolve é o relatório do enlace; a bancada
    // clássica continua respondendo PONG a um ping manual.
    if (range::role() == range::Role::Rx) {
      transmit("RNGA", range::ackPayload());
    } else {
      transmit("PONG", pendingReply);
    }
    pendingReply = "";
  }

  // Só o transmissor gera tráfego periódico. No receptor, transmitir no meio de
  // um teste de alcance é ruído em cima do que se está medindo.
  if (range::role() == range::Role::Tx && beaconEnabled &&
      now >= nextBeaconAt && !radio.isTransmitting()) {
    nextBeaconAt = now + rangeIntervalMs();
    if (radio.sniffing() && now < elrsHoldUntil) {
      // Calado: há outro transmissor ExpressLRS no ar. Volta sozinho 5 s depois
      // do último pacote dele, então desligar o rádio comercial basta.
      nextBeaconAt = now + 500;
    } else if (radio.sniffing()) {
      // Modo escuta com papel de transmissor = SIMULADOR. Emite SYNC do
      // ExpressLRS, assinado com o CRC14 do nosso UID, então o receptor o
      // valida pelo mesmo caminho que valida o transmissor comercial. Assim dá
      // pra medir alcance sem depender do rádio de terceiro estar ligado e por
      // perto.
      //
      // rateIndex 9 = 50 Hz, que é a taxa em que o transmissor de referência
      // foi encontrado pelo `elrsscan`.
      uint8_t pkt[8];
      express::buildSync(pkt, elrsFhssIndex, elrsNonce, 9);
      const int16_t st = radio.sendRaw(pkt, sizeof(pkt));
      if (st == LoraLink::ERR_NONE) {
        txCount++;
        ++elrsNonce;
        // O índice de FHSS de um transmissor real percorre a tabela; aqui ele
        // só varia pra o campo não ficar constante. A frequência não salta:
        // ficamos no canal de sync, que é onde o receptor escuta.
        elrsFhssIndex = (elrsFhssIndex + 1) % 80;
      } else {
        Serial.printf("  TX ELRS FALHOU: %s\n", LoraLink::errorName(st));
      }
    } else {
      transmit("RNG", String(radio.state().powerDbm) + "dBm");
    }
  }

  // Uma linha a cada 5 s no transmissor, no lugar da cascata de quadros: quantos
  // saíram e o que o receptor está relatando. Se o relatório parou de chegar,
  // dizer há quanto tempo é mais útil do que repetir o último valor como se
  // ainda valesse.
  if (range::role() == range::Role::Rx && now >= nextTxSummaryAt) {
    nextTxSummaryAt = now + telemetryPeriodMs();
    printTelemetry();
    if (quietMode) {
      // nada além da telemetria
    } else if (range::linked()) {
      Serial.printf("  LQ %3u%% | RSSI %6.1f dBm | SNR %5.1f dB | rx %lu perdidos %lu\n",
                    range::lq(), range::rssi(), range::snr(),
                    static_cast<unsigned long>(range::received()),
                    static_cast<unsigned long>(range::lost()));
    } else {
      Serial.printf("  sem sinal | rx %lu perdidos %lu\n",
                    static_cast<unsigned long>(range::received()),
                    static_cast<unsigned long>(range::lost()));
    }
  }

  if (range::role() == range::Role::Tx && now >= nextTxSummaryAt) {
    nextTxSummaryAt = now + telemetryPeriodMs();
    printTelemetry();
    const uint32_t ackAt = range::lastAckMs();
    if (quietMode) {
      // nada além da telemetria
    } else if (ackAt == 0) {
      Serial.printf("  TX %lu quadros | receptor: sem relatorio ainda\n",
                    static_cast<unsigned long>(txCount));
    } else {
      Serial.printf("  TX %lu quadros | receptor: %s | ha %lu s\n",
                    static_cast<unsigned long>(txCount),
                    range::lastAck().c_str(),
                    static_cast<unsigned long>((now - ackAt) / 1000));
    }
  }

  range::noteCadence(rangeIntervalMs());
  updateStatusLed();

  if (awaitingPong && now - pingSentAt > 10000) {
    awaitingPong = false;
    Serial.println(F("  ping timed out (no PONG within 10 s)"));
  }
}
