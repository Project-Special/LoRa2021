#include "WebConfig.h"

#include <LittleFS.h>
#include <WiFi.h>

namespace {
constexpr char kApPassword[] = "lora2021";
}

bool WebConfig::begin(LoraLink& radio, const Hooks& hooks) {
  radio_ = &radio;
  hooks_ = hooks;

  if (!LittleFS.begin(false)) {
    // Sem sistema de arquivos a API ainda funciona, mas não há página. É o caso
    // clássico de ter esquecido o `pio run -t uploadfs`, então vale o aviso.
    Serial.println(F("[web] LittleFS não montou - rodou 'pio run -t uploadfs'?"));
  }

  ssid_ = String("LoRa2021-");
  if (hooks_.roleTag) ssid_ += String(hooks_.roleTag) + "-";
  ssid_ += hooks_.nodeId ? hooks_.nodeId : "0000";
  WiFi.mode(WIFI_AP);
  WiFi.softAP(ssid_.c_str(), kApPassword);
  ip_ = WiFi.softAPIP();

  server_.on("/api/state", HTTP_GET, [this] { handleState_(); });
  server_.on("/api/config", HTTP_POST, [this] { handleConfig_(); });
  server_.on("/api/send", HTTP_POST, [this] { handleSend_(); });
  server_.on("/api/ping", HTTP_POST, [this] { handlePing_(); });

  server_.serveStatic("/", LittleFS, "/index.html");
  server_.serveStatic("/index.html", LittleFS, "/index.html");
  server_.serveStatic("/style.css", LittleFS, "/style.css", "max-age=86400");
  server_.serveStatic("/app.js", LittleFS, "/app.js", "max-age=86400");

  server_.onNotFound([this] { server_.send(404, "text/plain", "nao encontrado"); });
  server_.begin();

  ready_ = true;
  apUp_ = true;
  apDeadline_ = millis() + kApGraceMs;
  logLine("sys", String("painel em http://") + ip_.toString());
  return true;
}

void WebConfig::loop() {
  if (!ready_) return;
  if (apUp_) server_.handleClient();
  checkApGrace_();
}

void WebConfig::checkApGrace_() {
  if (!apUp_ || apKeep_) return;

  // Duas evidências de acesso, e qualquer uma basta. A associação ao AP cobre
  // quem entrou mas ainda não carregou a página; a contagem de requisições
  // cobre quem entrou e saiu dentro da janela — associar e desassociar rápido
  // deixaria o contador de estações em zero de novo.
  if (WiFi.softAPgetStationNum() > 0 || httpHits_ > 0) {
    apKeep_ = true;
    logLine("sys", "painel acessado — WiFi fica no ar ate o proximo reset");
    return;
  }

  if (static_cast<int32_t>(millis() - apDeadline_) < 0) return;

  // Desliga o rádio inteiro, não só o AP: é o transceptor de 2,4 GHz que
  // atrapalha o LoRa, e um softAPdisconnect sozinho o deixa ligado.
  server_.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  apUp_ = false;
  Serial.printf(
      "[web] ninguem acessou o painel em %lu s — WiFi desligado\n",
      static_cast<unsigned long>(kApGraceMs / 1000));
  Serial.println(F("[web] reinicie a placa (comando 'reset') pra ter o painel de volta"));
}

void WebConfig::logLine(const char* kind, const String& text) {
  log_[logHead_] = {logSeq_++, kind, text};
  logHead_ = (logHead_ + 1) % kLogSize;
}

String WebConfig::jsonEscape_(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    const char c = s[i];
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c >= 0x20) {
      out += c;
    }
  }
  return out;
}

String WebConfig::stateJson_() {
  const LoraLink::State& s = radio_->state();
  const BandProfile& p = bandProfile(s.band);
  const bool hf = isHighFreq(s.frequencyMHz);

  const uint32_t rxAgeMs =
      hooks_.lastRxMs ? (millis() - *hooks_.lastRxMs) : 0xFFFFFFFF;
  const bool linked = hooks_.lastRxMs && *hooks_.lastRxMs != 0 && rxAgeMs < 5000;

  String j;
  j.reserve(1600);
  j += '{';
  j += "\"node\":\"" + String(hooks_.nodeId ? hooks_.nodeId : "----") + "\",";
  j += "\"band\":\"" + String(p.alias) + "\",";
  j += "\"freq\":" + String(s.frequencyMHz, 3) + ',';
  j += "\"bw\":" + String(s.bandwidthKHz, 2) + ',';
  j += "\"sf\":" + String(s.spreadingFactor) + ',';
  j += "\"cr\":" + String(s.codingRate) + ',';
  j += "\"power\":" + String(s.powerDbm) + ',';
  j += "\"hf\":" + String(hf ? "true" : "false") + ',';
  j += "\"pmin\":" + String(hf ? -19 : -9) + ',';
  j += "\"pmax\":" + String(hf ? 12 : 22) + ',';
  j += "\"toa\":" + String(radio_->timeOnAirMs(32)) + ',';
  j += "\"linked\":" + String(linked ? "true" : "false") + ',';
  j += "\"radioOk\":" + String(radio_->isReady() ? "true" : "false") + ',';
  j += "\"radioErr\":\"" +
       jsonEscape_(LoraLink::errorName(radio_->lastInitState())) + "\",";

  const uint16_t matched = hooks_.matchedBand ? *hooks_.matchedBand : 915;
  j += "\"match\":" + String(matched) + ',';
  j += "\"mismatch\":" +
       String(isMismatched(matched, s.frequencyMHz) ? "true" : "false") + ',';
  const PeerId peerId = static_cast<PeerId>(hooks_.peer ? *hooks_.peer : PEER_BENCH);
  j += "\"peer\":\"" + String(peerProfile(peerId).id) + "\",";
  if (hooks_.phrase) {
    j += "\"phrase\":\"" + jsonEscape_(hooks_.phrase()) + "\",";
  }
  if (hooks_.uidText) {
    j += "\"uid\":\"" + jsonEscape_(hooks_.uidText()) + "\",";
  }
  j += "\"peerDecodes\":" +
       String(peerProfile(peerId).decodes ? "true" : "false") + ',';
  j += "\"peerOpts\":[";
  for (uint8_t i = 0; i < PEER_COUNT; i++) {
    if (i) j += ',';
    j += "{\"id\":\"" + String(kPeerProfiles[i].id) + "\",";
    j += "\"name\":\"" + jsonEscape_(kPeerProfiles[i].name) + "\",";
    j += "\"note\":\"" + jsonEscape_(kPeerProfiles[i].note) + "\"}";
  }
  j += "],";

  j += "\"matchOpts\":[";
  for (uint8_t i = 0; i < kMatchCount; i++) {
    if (i) j += ',';
    j += String(kMatchOptions[i].label);
  }
  j += "],";

  j += "\"beacon\":" +
       String(hooks_.beaconEnabled && *hooks_.beaconEnabled ? "true" : "false") + ',';
  j += "\"interval\":" +
       String(hooks_.beaconIntervalMs ? *hooks_.beaconIntervalMs : 0) + ',';

  j += "\"tx\":" + String(hooks_.txCount ? *hooks_.txCount : 0) + ',';
  j += "\"rx\":" + String(hooks_.rxCount ? *hooks_.rxCount : 0) + ',';
  j += "\"err\":" + String(radio_->receiveErrors()) + ',';
  j += "\"rssi\":" + String(hooks_.lastRssi ? *hooks_.lastRssi : 0.0f, 1) + ',';
  j += "\"snr\":" + String(hooks_.lastSnr ? *hooks_.lastSnr : 0.0f, 1) + ',';
  j += "\"rtt\":" + String(hooks_.lastRttMs ? *hooks_.lastRttMs : 0) + ',';

  j += "\"bands\":[";
  for (uint8_t i = 0; i < BAND_COUNT; i++) {
    if (i) j += ',';
    j += "{\"id\":\"" + String(kBandProfiles[i].alias) + "\",";
    j += "\"name\":\"" + jsonEscape_(kBandProfiles[i].name) + "\",";
    j += "\"note\":\"" + jsonEscape_(kBandProfiles[i].note) + "\"}";
  }
  j += "],";

  // O anel é percorrido do mais antigo para o mais novo; o painel filtra pelo
  // id o que ainda não mostrou.
  j += "\"log\":[";
  bool first = true;
  for (uint8_t k = 0; k < kLogSize; k++) {
    const Entry& e = log_[(logHead_ + k) % kLogSize];
    if (!e.kind) continue;
    if (!first) j += ',';
    first = false;
    j += "{\"i\":" + String(e.id) + ",\"k\":\"" + String(e.kind) +
         "\",\"t\":\"" + jsonEscape_(e.text) + "\"}";
  }
  j += "]}";
  return j;
}

void WebConfig::handleState_() {
  ++httpHits_;
  server_.send(200, "application/json", stateJson_());
}

void WebConfig::handleConfig_() {
  int16_t state = LoraLink::ERR_NONE;
  const char* failed = nullptr;
  // Mexeu no rádio = precisa gravar. Trocar de par zera isto: lá o ajuste
  // manual é apagado, não salvo.
  bool touched = false;

  // A banda vem primeiro: ela reescreve frequência, modem e potência de uma vez,
  // e os campos individuais logo abaixo ainda podem refinar por cima.
  if (server_.hasArg("band")) {
    BandId id;
    if (bandFromAlias(server_.arg("band"), id)) {
      state = radio_->applyBand(id);
      if (state != LoraLink::ERR_NONE) failed = "banda";
      else touched = true;
    } else {
      server_.send(400, "text/plain", "banda desconhecida");
      return;
    }
  }

  if (!failed && server_.hasArg("freq")) {
    state = radio_->setFrequency(server_.arg("freq").toFloat());
    if (state != LoraLink::ERR_NONE) failed = "frequencia";
    else touched = true;
  }
  if (!failed && server_.hasArg("bw")) {
    state = radio_->setBandwidth(server_.arg("bw").toFloat());
    if (state != LoraLink::ERR_NONE) failed = "largura de banda";
    else touched = true;
  }
  if (!failed && server_.hasArg("sf")) {
    state = radio_->setSpreadingFactor(server_.arg("sf").toInt());
    if (state != LoraLink::ERR_NONE) failed = "fator de espalhamento";
    else touched = true;
  }
  if (!failed && server_.hasArg("cr")) {
    state = radio_->setCodingRate(server_.arg("cr").toInt());
    if (state != LoraLink::ERR_NONE) failed = "taxa de codigo";
    else touched = true;
  }
  // Potência por último: o limite muda com a banda, e assim ela é validada
  // contra a frequência que acabou de valer.
  if (!failed && server_.hasArg("power")) {
    state = radio_->setPower(server_.arg("power").toInt());
    if (state != LoraLink::ERR_NONE) failed = "potencia";
    else touched = true;
  }

  // Rede de casamento: não toca no rádio, só registra como o módulo está
  // montado. Persiste, porque é característica física da placa.
  if (server_.hasArg("match")) {
    const uint16_t m = static_cast<uint16_t>(server_.arg("match").toInt());
    if (!isMatchOption(m)) {
      server_.send(400, "text/plain", "rede de casamento invalida");
      return;
    }
    if (hooks_.setMatchedBand) hooks_.setMatchedBand(m);
  }

  // Frase de binding ANTES do par: ela redefine o UID, e é do UID que sai a
  // inversão de IQ que o par aplica. Na outra ordem, trocar frase e par no mesmo
  // POST deixaria o rádio com o IQ da frase antiga.
  if (server_.hasArg("phrase")) {
    const String text = server_.arg("phrase");
    if (!hooks_.setPhrase || !hooks_.setPhrase(text)) {
      server_.send(400, "text/plain", "frase invalida (1 a 63 caracteres)");
      return;
    }
  }

  // Par de teste: aplica a modulação do lado escolhido. Vem depois dos campos
  // individuais pra que escolher um par sobreponha ajustes manuais anteriores.
  if (server_.hasArg("peer")) {
    PeerId pid;
    if (!peerFromId(server_.arg("peer"), pid)) {
      server_.send(400, "text/plain", "par desconhecido");
      return;
    }
    if (hooks_.setPeer) {
      // O hook aplica a camada física INTEIRA — modem, potência do perfil e
      // modo escuta — e apaga o ajuste manual gravado. Repetir applyModem aqui
      // depois disso só desfazia parte do que ele acabou de fazer.
      hooks_.setPeer(static_cast<uint8_t>(pid));
    } else {
      const PeerProfile& pp = peerProfile(pid);
      state = radio_->applyModem(pp.frequencyMHz, pp.bandwidthKHz,
                                 pp.spreadingFactor, pp.codingRate);
      if (state != LoraLink::ERR_NONE) failed = "par de teste";
    }
    // O par manda: o que vier junto no mesmo POST não vira ajuste gravado.
    touched = false;
  }

  if (server_.hasArg("beacon") && hooks_.beaconEnabled) {
    *hooks_.beaconEnabled = server_.arg("beacon") == "1";
  }
  if (server_.hasArg("interval") && hooks_.beaconIntervalMs) {
    const long v = server_.arg("interval").toInt();
    if (v >= 200) *hooks_.beaconIntervalMs = static_cast<uint32_t>(v);
  }

  if (failed) {
    const String msg =
        String(failed) + ": " + LoraLink::errorName(state) + " (" + state + ")";
    logLine("err", msg);
    server_.send(400, "text/plain", msg);
    return;
  }

  // Grava só no fim, e só se tudo deu certo: uma requisição que falhou no meio
  // deixaria metade da configuração nova e metade da velha na NVS.
  if (touched && hooks_.onRadioChanged) hooks_.onRadioChanged();

  server_.send(200, "application/json", stateJson_());
}

void WebConfig::handleSend_() {
  const String text = server_.hasArg("text") ? server_.arg("text") : String("hello");
  if (hooks_.sendText) hooks_.sendText(text);
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebConfig::handlePing_() {
  if (hooks_.sendPing) hooks_.sendPing();
  server_.send(200, "application/json", "{\"ok\":true}");
}
