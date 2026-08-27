#pragma once

#include <Arduino.h>
#include <WebServer.h>

#include <functional>

#include "LoraLink.h"

// Painel de configuração servido pelo próprio ESP32.
//
// Sobe um ponto de acesso, serve os arquivos de data/ (LittleFS) e expõe uma
// API REST mínima. Usa o WebServer síncrono do core em vez do assíncrono de
// propósito: são poucas requisições curtas, e assim o projeto não ganha duas
// dependências externas só pra ter uma página de ajustes.
class WebConfig {
 public:
  // Tudo que o painel precisa ler ou acionar no app. Ponteiros em vez de cópia
  // porque o loop principal continua dono do estado.
  struct Hooks {
    const char* nodeId = nullptr;
    // Etiqueta curta do papel ("RX" / "TX"), que entra no nome do access point.
    //
    // O id de nó sai do MAC, então não diz nada sobre a função da placa: na
    // lista de redes do celular apareciam duas LoRa2021-<hex> e não havia como
    // saber qual era qual sem abrir as duas. Com as placas separadas em campo,
    // isso é convite a mexer na errada.
    const char* roleTag = nullptr;
    bool* beaconEnabled = nullptr;
    uint32_t* beaconIntervalMs = nullptr;
    uint32_t* txCount = nullptr;
    uint32_t* rxCount = nullptr;
    float* lastRssi = nullptr;
    float* lastSnr = nullptr;
    uint32_t* lastRttMs = nullptr;
    uint32_t* lastRxMs = nullptr;   // pra decidir se o enlace está vivo
    // Qualidade de enlace e quadros perdidos, do teste de alcance.
    //
    // Por função e não por ponteiro: o LQ é CALCULADO sobre uma janela
    // deslizante em range_test, não um contador guardado. Expor um ponteiro
    // obrigaria alguém a manter uma cópia sincronizada — e uma cópia
    // desatualizada de "qualidade do enlace" é o pior tipo de mentira num
    // painel de diagnóstico.
    std::function<uint8_t()> linkQuality;
    std::function<uint32_t()> lostFrames;
    // Rede de casamento sub-GHz fechada na matriz de solda do módulo. Não é
    // ajuste de rádio: é o firmware sabendo como o hardware está montado.
    uint16_t* matchedBand = nullptr;
    std::function<void(uint16_t)> setMatchedBand;
    // Par de teste: o que o usuário declara estar do outro lado do enlace.
    uint8_t* peer = nullptr;
    std::function<void(uint8_t)> setPeer;
    // Frase de binding do ExpressLRS. O painel a edita, mas quem sabe derivar o
    // UID e reaplicar o par é o app — daí ser um par leitura/escrita por
    // função, e não um ponteiro solto.
    std::function<String()> phrase;
    std::function<String()> uidText;
    // Devolve false se a frase for recusada (vazia ou longa demais).
    std::function<bool(const String&)> setPhrase;

    // Chamado depois de QUALQUER mudança de rádio bem-sucedida vinda do
    // painel — banda, frequência, largura, SF, CR ou potência.
    //
    // É o gancho que GRAVA a escolha na placa. Sem ele o painel só mexia na
    // memória: a tela mostrava 433 MHz, e o próximo reset devolvia a banda do
    // par sem dizer nada. Trocar de par não passa por aqui de propósito — o
    // par traz a própria banda e apaga o ajuste manual.
    std::function<void()> onRadioChanged;

    std::function<void(const String&)> sendText;
    std::function<void()> sendPing;
  };

  bool begin(LoraLink& radio, const Hooks& hooks);
  void loop();

  // O access point está no ar? Vira false quando a janela de cortesia expira
  // sem ninguém ter entrado.
  bool wifiUp() const { return apUp_; }

  // Empurra uma linha pro registro do painel. `kind` é rx | tx | err | sys —
  // vira a classe CSS da linha.
  void logLine(const char* kind, const String& text);

  const String& ssid() const { return ssid_; }
  const IPAddress& ip() const { return ip_; }

  // Quanto tempo o AP fica no ar esperando alguém entrar.
  //
  // O rádio WiFi do ESP32 é 2,4 GHz, a mesma banda em que o LoRa2021 opera nos
  // pares 2G4 — o AP dessensibiliza o próprio receptor da placa. Num teste de
  // alcance isso penaliza o 2.4 GHz por um motivo que não tem nada a ver com a
  // banda. Deixar o painel morrer sozinho resolve sem exigir disciplina de quem
  // está no campo: se ninguém abriu o painel, ele não era necessário.
  //
  // Basta UM acesso dentro da janela pra o AP ficar de pé até o próximo reset.
  static constexpr uint32_t kApGraceMs = 120000;

 private:
  static constexpr uint8_t kLogSize = 24;

  struct Entry {
    uint32_t id;
    const char* kind;
    String text;
  };

  void handleState_();
  void handleConfig_();
  void handleSend_();
  void handlePing_();

  String stateJson_();
  static String jsonEscape_(const String& s);

  WebServer server_{80};
  LoraLink* radio_ = nullptr;
  Hooks hooks_{};

  Entry log_[kLogSize];
  uint32_t logSeq_ = 0;
  uint8_t logHead_ = 0;

  void checkApGrace_();

  String ssid_;
  IPAddress ip_;
  bool ready_ = false;
  bool apUp_ = false;
  bool apKeep_ = false;      // alguém entrou: não desliga mais
  uint32_t apDeadline_ = 0;
  uint32_t httpHits_ = 0;
};
