#include "express.h"

#include <Preferences.h>
#include <esp_rom_md5.h>

#include "settings.h"

namespace express {
namespace {

Preferences prefs;
constexpr const char* kNamespace = settings::kNamespace;

uint8_t uid_[6] = {0};

// Frase em uso. 63 caracteres cobrem com folga qualquer frase de binding real —
// o ExpressLRS trunca bem antes disso — e mantém o buffer do MD5 dentro do
// tamanho fixo declarado em deriveUid().
char phrase_[64] = BIND_PHRASE;

// Par com que uma placa virgem nasce. LINK_PEER, quando o build o define;
// senão escutar o transmissor ExpressLRS 2.4 GHz, que é o alvo validado deste
// protótipo. Vale só com a NVS vazia — ver begin().
#ifdef LINK_PEER
constexpr uint8_t kFactoryPeer = static_cast<uint8_t>(LINK_PEER);
#else
constexpr uint8_t kFactoryPeer = PEER_ELRS_2G4;
#endif

uint8_t peer_ = kFactoryPeer;
uint32_t valid_ = 0;
uint32_t raw_ = 0;

RcChannels rc_{};
uint32_t rcAt_ = 0;
uint32_t rcCount_ = 0;

// O ExpressLRS NÃO hasheia a frase pura: o binary_configurator monta a string
// -DMY_BINDING_PHRASE="<frase>" e tira o MD5 DISSO. Errar esse detalhe muda o
// UID e, com ele, a inversão de IQ e a semente do CRC — o receptor demodula
// tudo e reprova 100% dos pacotes, sintoma que parece falha de RF.
void deriveUid() {
  char buf[96];
  const int n = snprintf(buf, sizeof(buf), "-DMY_BINDING_PHRASE=\"%s\"", phrase_);
  md5_context_t ctx;
  uint8_t digest[16];
  esp_rom_md5_init(&ctx);
  esp_rom_md5_update(&ctx, reinterpret_cast<const uint8_t*>(buf), n > 0 ? n : 0);
  esp_rom_md5_final(digest, &ctx);
  memcpy(uid_, digest, sizeof(uid_));
}

void savePeer(uint8_t v) {
  if (v >= PEER_COUNT) return;
  peer_ = v;
  prefs.begin(kNamespace, false);
  prefs.putUChar("peer", v);
  prefs.end();
}

}  // namespace

void begin() {
  // A frase salva vem antes do UID: é dela que o UID sai.
  prefs.begin(kNamespace, true);
  const String saved = prefs.getString("phrase", "");
  prefs.end();
  if (saved.length() > 0 && saved.length() < sizeof(phrase_)) {
    strncpy(phrase_, saved.c_str(), sizeof(phrase_) - 1);
    phrase_[sizeof(phrase_) - 1] = '\0';
  }
  deriveUid();

  // Padrão de PRIMEIRA GRAVAÇÃO, não de todo boot.
  //
  // O build flag LINK_PEER decidia a banda a cada partida, descartando o que
  // estivesse na NVS. Isso resolvia o problema de manter as duas placas na
  // mesma faixa, mas ao custo de tornar o painel mentiroso: escolher 433 na
  // tela funcionava até o próximo reset e então voltava sozinho, sem aviso
  // nenhum, para o valor compilado. Agora o define só preenche a NVS vazia —
  // a placa recém-gravada nasce na banda certa, e a partir daí quem manda é o
  // painel.
  prefs.begin(kNamespace, true);
  const bool stored = prefs.isKey("peer");
  const uint8_t v = prefs.getUChar("peer", kFactoryPeer);
  prefs.end();
  peer_ = (v < PEER_COUNT) ? v : kFactoryPeer;

  // Grava o padrão de fábrica de uma vez, para o painel abrir já mostrando o
  // par de verdade em vez de um valor que só existe na memória.
  if (!stored) savePeer(peer_);
}

const uint8_t* uid() { return uid_; }
const char* phrase() { return phrase_; }
const char* defaultPhrase() { return BIND_PHRASE; }

bool setPhrase(const String& text) {
  if (text.length() == 0 || text.length() >= sizeof(phrase_)) return false;
  strncpy(phrase_, text.c_str(), sizeof(phrase_) - 1);
  phrase_[sizeof(phrase_) - 1] = '\0';
  deriveUid();

  prefs.begin(kNamespace, false);
  prefs.putString("phrase", phrase_);
  prefs.end();
  return true;
}
bool iqInverted() { return (uid_[5] & 0x01) != 0; }

String uidText() {
  char b[24];
  snprintf(b, sizeof(b), "%02X %02X %02X %02X %02X %02X", uid_[0], uid_[1],
           uid_[2], uid_[3], uid_[4], uid_[5]);
  return String(b);
}

PeerId peer() { return static_cast<PeerId>(peer_); }
const PeerProfile& peerInfo() { return peerProfile(peer()); }

bool peerFromToken(const String& token, PeerId& out) {
  return peerFromId(token, out);
}

int16_t applyPeer(LoraLink& radio, PeerId id) {
  const PeerProfile& pp = peerProfile(id);

  int16_t state = radio.applyModem(pp.frequencyMHz, pp.bandwidthKHz,
                                   pp.spreadingFactor, pp.codingRate);
  if (state != LoraLink::ERR_NONE) return state;

  // A potência vem do perfil, depois da frequência: o teto do PA muda com a
  // banda, e applyModem já limitou o valor anterior ao novo teto. Sem esta
  // linha, ir de 2.4 GHz (12 dBm) para 433 manteria os 12 dBm — dentro da
  // faixa, porém 10 dB abaixo do que o rádio entrega ali.
  radio.setPower(pp.powerDbm);

  // payloadLen 0 devolve o rádio ao modo normal da bancada; > 0 liga a camada
  // física do ELRS. A inversão de IQ vem do UID, igual ao IHM faz.
  state = radio.setSniff(pp.payloadLen, pp.preambleLen, iqInverted(),
                         pp.longInterleaver);
  if (state == LoraLink::ERR_NONE) savePeer(static_cast<uint8_t>(id));
  return state;
}

// CRC14 do ExpressLRS sobre os 7 primeiros bytes do pacote OTA4. Polinômio
// 0x2E57 e inicializador ((UID[4]<<8)|UID[5]) ^ OTA_VERSION_ID, do OTA.cpp da
// série 3.x (OTA_VERSION_ID = 3).
// CRC14 sobre os 7 primeiros bytes do pacote. Extraído de crcOk() porque agora
// serve aos dois sentidos: validar o que chega e assinar o que sai.
uint16_t crc14(const uint8_t* p) {
  uint16_t crc = (static_cast<uint16_t>(uid_[4]) << 8) | uid_[5];
  crc ^= 3;

  // O byte 0 entra no cálculo com os 6 bits de crcHigh zerados: só o campo de
  // tipo permanece. É por isso que apenas o SYNC valida às cegas — no RCDATA
  // aqueles bits carregam o nonce.
  uint8_t buf[7];
  buf[0] = p[0] & 0x03;
  memcpy(&buf[1], &p[1], 6);

  for (uint8_t i = 0; i < 7; i++) {
    crc ^= static_cast<uint16_t>(buf[i]) << 6;
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x2000) ? static_cast<uint16_t>((crc << 1) ^ 0x2E57)
                           : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc & 0x3FFF;
}

/**
 * CRC14 com semente explícita.
 *
 * O crc14() acima assume a semente do SYNC (nonce zero). O RCDATA usa
 * `OtaCrcInitializer ^ nonce`, então o cálculo precisa aceitar a semente de
 * fora — é a única diferença entre validar um e outro.
 */
static uint16_t crc14Seeded(const uint8_t* p, uint16_t seed) {
  uint16_t crc = seed;

  uint8_t buf[7];
  buf[0] = p[0] & 0x03;
  memcpy(&buf[1], &p[1], 6);

  for (uint8_t i = 0; i < 7; i++) {
    crc ^= static_cast<uint16_t>(buf[i]) << 6;
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x2000) ? static_cast<uint16_t>((crc << 1) ^ 0x2E57)
                           : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc & 0x3FFF;
}

/**
 * Desempacota 4 canais de 10 bits de 5 bytes.
 *
 * Portado de UnpackChannels4x10ToUInt11 (OTA.cpp:306), sem a expansão para 11
 * bits: aqui o valor cru de 10 bits basta, porque a barra do painel é
 * proporcional e não precisa da escala CRSF.
 */
static void unpack4x10(const uint8_t* payload, uint16_t* dest) {
  uint8_t bitsMerged = 0;
  uint32_t readValue = 0;
  unsigned readByteIndex = 0;
  for (uint8_t n = 0; n < 4; n++) {
    while (bitsMerged < 10) {
      readValue |= static_cast<uint32_t>(payload[readByteIndex++]) << bitsMerged;
      bitsMerged += 8;
    }
    dest[n] = static_cast<uint16_t>(readValue & 0x3FF);
    readValue >>= 10;
    bitsMerged -= 10;
  }
}

bool decodeRc(const uint8_t* p, uint8_t len, RcChannels& out) {
  if (len < 8) return false;
  if ((p[0] & 0x03) != 0) return false;  // tipo 0 = RCDATA

  const uint16_t rx = ((static_cast<uint16_t>(p[0]) >> 2) << 8) | p[7];
  const uint16_t base = ((static_cast<uint16_t>(uid_[4]) << 8) | uid_[5]) ^ 3;

  // Força bruta no nonce. 256 chaves, cada uma 7 bytes de CRC: microssegundos.
  //
  // Começa pelo nonce seguinte ao último aceito — num enlace vivo ele
  // incrementa de um em um, então o primeiro palpite quase sempre acerta e o
  // laço sai na primeira volta.
  for (uint16_t k = 0; k < 256; k++) {
    const uint8_t nonce = static_cast<uint8_t>(rc_.nonce + 1 + k);
    if (crc14Seeded(p, base ^ nonce) != rx) continue;

    unpack4x10(&p[1], out.ch);
    out.switches = p[6] & 0x7F;
    out.ch4 = (p[6] >> 7) & 0x01;
    out.nonce = nonce;
    return true;
  }
  return false;
}

const RcChannels& rc() { return rc_; }
uint32_t rcAgeMs() { return rcAt_ ? (millis() - rcAt_) : 0xFFFFFFFF; }
uint32_t rcCount() { return rcCount_; }

bool crcOk(const uint8_t* p, uint8_t len) {
  if (len < 8) return false;
  const uint16_t rx = ((static_cast<uint16_t>(p[0]) >> 2) << 8) | p[7];
  return crc14(p) == rx;
}

void buildSync(uint8_t* out, uint8_t fhssIndex, uint8_t nonce,
               uint8_t rateIndex, uint8_t tlmRatio, bool switchEncMode) {
  out[0] = 0x02;  // tipo SYNC; os 6 bits de crcHigh entram no fim
  out[1] = fhssIndex;
  out[2] = nonce;
  out[3] = static_cast<uint8_t>((rateIndex & 0x0F) << 4 |
                                (tlmRatio & 0x07) << 1 |
                                (switchEncMode ? 1 : 0));
  out[4] = uid_[3];
  out[5] = uid_[4];
  out[6] = uid_[5];

  // O CRC é calculado com crcHigh zerado — é a mesma regra da validação, e por
  // isso a assinatura tem de vir depois de todos os outros campos.
  const uint16_t crc = crc14(out);
  out[0] = static_cast<uint8_t>((crc >> 8) << 2 | 0x02);
  out[7] = static_cast<uint8_t>(crc & 0xFF);
}

bool describe(const uint8_t* p, uint8_t len, String& out) {
  // Conta ANTES de julgar: o que interessa aqui é quantos pacotes o rádio
  // conseguiu demodular, e isso não depende do CRC passar.
  raw_++;

  // Cada tipo valida do seu jeito, porque a semente do CRC difere: o SYNC usa
  // nonce zero e o RCDATA usa o nonce corrente (OTA.cpp:531). Tratar os dois
  // com crcOk() reprovava 100% dos RCDATA — era por isso que os manches nunca
  // apareciam.
  const uint8_t tipo = p[0] & 0x03;
  bool ok = false;
  RcChannels ch{};

  if (tipo == 0) {
    ok = decodeRc(p, len, ch);
    if (ok) {
      rc_ = ch;
      rcAt_ = millis();
      rcCount_++;
    }
  } else {
    ok = crcOk(p, len);
  }
  if (!ok) return false;
  valid_++;

  out = "";
  char b[8];
  for (uint8_t i = 0; i < len; i++) {
    snprintf(b, sizeof(b), "%02X ", p[i]);
    out += b;
  }

  out += '[';
  out += tipo == 0 ? "RCDATA" : tipo == 2 ? "SYNC" : "outro";
  out += ']';

  if (tipo == 0) {
    snprintf(b, sizeof(b), " %u", ch.ch[0]);
    out += " A";
    out += ch.ch[0];
    out += " E";
    out += ch.ch[1];
    out += " T";
    out += ch.ch[2];
    out += " R";
    out += ch.ch[3];
  }
  return true;
}

uint32_t validCount() { return valid_; }
uint32_t rawCount() { return raw_; }

}  // namespace express
