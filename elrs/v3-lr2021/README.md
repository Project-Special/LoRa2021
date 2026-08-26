# LoRa2021 como transmissor ExpressLRS 3.x (OTA v3)

Objetivo: o LoRa2021 (LR2021) conversar no ar com o **SX1280 do IHM**, do mesmo
jeito que os transmissores ExpressLRS comerciais com que o IHM já funciona.

Como o IHM fala **OTA v3**, a base aqui é o **ExpressLRS 3.6.4**, não a 4.2 —
esta pasta é um overlay aplicado sobre um clone da 3.6.4.

## Por que 3.6.4

Diff da cópia do IHM (`lib/ELRSRadio/`) contra o upstream 3.6.4, só o que vai
pro ar:

| arquivo | divergência |
|---|---|
| `crc.cpp` | **0 linhas** |
| `OTA.h` | includes + `tlmFlag` no caminho MSP (não usado) |
| `OTA.cpp` | includes, `CRSF_to_SWITCH3b` embutido (caminho hybrid8, não usado), `backupCrcHigh` (não afeta o fio) |
| `FHSS.cpp` | tabela ISM2G4 idêntica; `sync_channel`, `freq_spread` e geração de sequência iguais |

Para **RCDATA + SYNC em `smWideOr8ch`** — o que o IHM usa — a 3.6.4 é
wire-idêntica a ele. Construindo em cima dela, a compatibilidade vem por
construção, sem copiar nada do projeto do IHM.

## Modo dual band

A tabela tem entradas dual (10–11), mas elas exigem **dois módulos**. No
ExpressLRS "dual band" (*Gemini Xrossband*) significa transmitir o mesmo pacote
**simultaneamente** em 900 MHz e 2.4 GHz — e um modem não gera duas portadoras
ao mesmo tempo. A própria 3.6.4 recusa:

```c
// src/common.cpp — isSupportedRFRate()
if (GPIO_PIN_NSS_2 == UNDEF_PIN && ModParams->radio_type == RADIO_TYPE_LR1121_LORA_DUAL)
    return false;
```

Então há dois níveis:

| | hardware | o que dá |
|---|---|---|
| **Banda comutável** | 1× LoRa2021 | escolhe 900 MHz **ou** 2.4 GHz pela taxa; as duas portas de RF do módulo já servem |
| **Gemini dual band** | 2× LoRa2021 | as duas bandas ao mesmo tempo; use o layout `Gemini`, que preenche `radio_nss_2`/`busy_2`/`dio1_2`/`rst_2` |

## Alvo do enlace

```
taxa    : rateIndex 9 do IHM = LoRa · BW 800 kHz · SF8 · CR LI 4/8
          preâmbulo 12 · 20000 µs · OTA4 (8 B) · TLM 1:16 · hop 2
banda   : ISM2G4, 2400,4–2479,4 MHz, 80 canais
switch  : smWideOr8ch
frase   : mesma do IHM -> mesmo UID -> mesma semente FHSS e init de CRC
```

O LR2021 tem os mesmos registradores de modulação para isso
(`LR2021_RADIO_LORA_BW_800`, `_SF8`, `_CR_LI_4_8`), que é o que torna o
LR2021 ↔ SX1280 possível na camada física.

## Estado: FUNCIONANDO em hardware

Receptor validado contra um transmissor ExpressLRS 2.4 GHz (LiteRadio), na
placa ESP32-S3 com o módulo G-NiceRF LoRa2021:

```
LINK_STATISTICS  150 quadros em 15 s
RC_CHANNELS      706 quadros em 15 s
RSSI -36 dBm   LQ 100%   SNR +15 dB   rf_mode 2
```

### Configuração de hardware que fez funcionar

Três coisas foram descobertas na bancada, todas contra a suposição inicial:

| item | valor | como se soube |
|---|---|---|
| **TCXO** | **não existe** — módulo com cristal | varredura `tcxo scan`; datasheet V1.3 confirma que o pino 13 VTCXO é **saída** para um TCXO externo opcional |
| **IRQ** | **DIO9** | o módulo traz DIO7/8/9 crus, sem pino "IRQ"; o esquema típico do datasheet liga DIO9 ao host |
| **chave de antena** | **não tem** | duas portas de RF independentes (pino 9 sub-GHz, pino 10 2.4G/S) |

No layout isso virou: campo `radio_tcxo` **ausente** (presente com valor 0
significaria 1,6 V, não "sem TCXO") e `radio_rfsw_ctrl: [0,0,0,0,255,0,0]` —
só DIO9 como interrupção, nenhum DIO chaveando antena.

Com qualquer tensão de TCXO o chip responde por SPI (`Found LR2021`, `Base FW
version: 1.24`) mas a calibração falha com `device errors: 0x2081`. É um
sintoma que não aponta para a causa, então vale a nota.

### Duas placas, dois layouts

| alvo | placa | layout | SCK/MISO/MOSI/NSS/RST/BUSY/DIO9 |
|---|---|---|---|
| `lora2021.rx_dual.esp32s3` | ESP32-S3 DevKitC-1 | `LoRa2021 ESP32-S3.json` | 40 · 38 · 41 · 39 · 42 · 1 · 2 |
| `lora2021.rx_dual.esp32` | ESP32-WROOM-32 DevKit v1 | `LoRa2021 ESP32 classic.json` | 14 · 27 · 13 · 26 · 25 · 33 · 32 |

O layout do S3 se chamava `LoRa2021 ESP32.json`, e **os alvos `esp32` apontavam
para ele** — o receptor da DevKit v1 saía compilado com GPIOs 38/41/42, que
naquela placa nem existem. O nome genérico é que convidava ao erro, entao o do
S3 passou a dizer S3 no nome.

A pinagem da DevKit v1 e a mesma que a bancada validou: bloco contiguo D13..D32
do header direito, pulando o D12 (strapping MTDI — o BUSY do modulo pode
segura-lo alto no boot e a placa nao sobe).

Compilar cada um:

    pio run -e LoRa2021_S3_RX     # ESP32-S3
    pio run -e LoRa2021_RX        # ESP32-WROOM-32 DevKit v1

### Sobre o upstream

O [ExpressLRS 4.1.0](https://github.com/ExpressLRS/ExpressLRS/releases/tag/4.1.0)
(julho/2026) generalizou os caminhos de RF pensando no LR2021, mas o suporte
completo segue anunciado como *coming soon*. Este overlay continua sobre a
3.6.4, e por um motivo que nao e inercia: e a versao wire-identica ao OTA v3 que
o IHM fala (ver "Por que 3.6.4" acima).

### Gravar o receptor

```bash
cd elrs/ExpressLRS-v3/src
pio run -e LoRa2021_S3_RX
python python/binary_configurator.py \
    --target lora2021.rx_dual.esp32s3 \
    --phrase "<a frase do seu transmissor>" \
    --flash uart --port COM5 \
    .pio/build/LoRa2021_S3_RX/firmware.bin
```

O `binary_configurator` precisa rodar com o `firmware.bin` **dentro do
diretório de build** — ele procura `bootloader.bin` e `partitions.bin` ao lado.

A frase entra no binário como `{"uid": [...]}`. Sem ela o UID sai diferente, o
CRC reprova 100% dos pacotes, e o sintoma parece falha de RF.

### Acompanhar o receptor

A UART carrega **CRSF binário a 420000 baud**, não texto — e 420000 nem aparece
na lista de taxas do PuTTY ou do monitor da Arduino IDE, então esses mostram
lixo. Use o app do projeto, que já abre nessa taxa:

```bash
python tools/serial_app.py            # COM5 detectado sozinho
```

Ele mostra LQ, RSSI, SNR, potência do transmissor e os 16 canais RC em barras.

### WiFi do receptor

O receptor **tem** auto-start de WiFi: `devWIFI.cpp:1305` traz um ramo
`#elif defined(TARGET_RX)` que sobe o AP depois de N segundos sem enlace.

O que desliga isso não é o firmware, é o blob de opções: `devWIFI` lê
`doc["wifi-on-interval"] | -1`, e o `binary_configurator` **só grava essa chave
se `--auto-wifi` for passado**. Sem a flag o campo não existe, o default −1 vale
e o auto-start fica desabilitado — sem nenhum aviso. Por isso o `--auto-wifi 30`
na linha de gravação acima não é opcional.

AP: `ExpressLRS RX` / senha `expresslrs` / **10.0.0.1**. Também dá pra subir sob
demanda pelo script Lua → *WiFi Connectivity* → *Enable Rx WiFi*.

**Quando o WiFi sobe, o CRSF na UART para.** Na bancada, sem transmissor ligado,
isso acontece sempre: a telemetria começa por volta de t=18 s, roda a 2 quadros/s
e some em t=30 s em ponto. Parece receptor travado e não é — é o auto-WiFi
fazendo o que foi pedido. Em voo o enlace existe desde o início e o gatilho
nunca dispara. Se atrapalhar no bancada, regrave com `--auto-wifi 0`.

## Uso

```bash
python apply_overlay.py          # clona a 3.6.4 e aplica tudo (idempotente)

cd ../ExpressLRS-v3/src
pio run -e LoRa2021_TX           # ou LoRa2021_RX
python python/binary_configurator.py \
    --target lora2021.tx_dual.esp32 \
    --phrase "<a mesma frase do IHM>" --tx \
    .pio/build/LoRa2021_TX/firmware.bin
```

Estado: **TX e RX compilam** (TX RAM 21,0% / Flash 80,1%; RX 20,3% / 58,2%).

## Conteúdo

```
v3-lr2021/
├── apply_overlay.py               aplica tudo sobre o clone
├── user_defines.txt               domínio regulatório + debug
├── lib/LR2021Driver/              driver da branch 4.2/lr2021 + overloads de compat
├── lib/SX12xxDriverCommon/        classe base da 3.6.4 + retroportes
└── hardware/
    ├── targets.partial.json
    ├── TX/LoRa2021 ESP32.json            um módulo
    ├── TX/LoRa2021 ESP32 Gemini.json     dois módulos (dual band real)
    └── RX/LoRa2021 ESP32.json
```

Nada nosso vive dentro do clone — o `apply_overlay.py` copia pra dentro, então
`git pull` na 3.6.4 não conflita: é só rodar o script de novo.

## Como o overlay funciona

Do ponto de vista do firmware o LR2021 é **o mesmo caso do LR1121**: rádio de
banda dupla, com `bw2/sf2/cr2`, tabela FHSS secundária e duas tabelas de
potência. Então o grosso do trabalho é alargar as 44 guardas `RADIO_LR1121` da
3.6.4 para aceitarem também `RADIO_LR2021`, em vez de escrever caminho novo.

Detalhes que exigiram cuidado:

- **Duas guardas ficam protegidas** do alargamento — as que instanciam `Radio` e
  declaram a tabela de taxas. Alargar essas duplicaria os símbolos.
- **A tabela de taxas é derivada em tempo de aplicação** a partir da do LR1121
  no próprio clone, trocando `LR11XX_*` por `LR2021_*`. Assim ela acompanha o
  upstream em vez de virar uma cópia congelada.
- **Aliases de compilação** (`RADIO_TYPE_LR1121_* → RADIO_TYPE_LR2021_*`): como
  só um rádio é compilado por vez, todo o código compartilhado continua escrito
  em termos de LR1121 e funciona sem edição.
- **Dois overloads no driver** traduzem a convenção de chamada da 3.6.4
  (`Config` com 10 argumentos, `TXnb` com 2) para a assinatura nativa do LR2021,
  que veio da 4.x. Assim `tx_main` e `rx_main` compilam intocados. A banda sai
  da própria frequência — mesmo critério que o driver usa internamente.
- **Retroportes** da 4.x: `RadioBandMod`, `RXdataBufferSecond`,
  `hasSecondRadioGotData`, os campos de layout `radio_tcxo`/`radio_tcxo_delay` e
  o ramo do chip no gerador da página web.

Ficam **de fora** do alargamento: `lib/WIFI/lr1121.*` e os trechos de `devWIFI`
que atualizam o firmware *do LR1121* pela página web (específicos daquele chip),
e `lib/LBT/*` (só exigido no domínio EU CE).

## Tabela de taxas

| índice | banda | observação |
|---|---|---|
| 0–3, 12–13 | sub-GHz 900 | BW 500 kHz |
| 4–9 | 2.4 GHz | BW 800 kHz — o **9** é o do IHM |
| 10–11 | dual band | só com dois módulos |

## Potência

O driver do LR2021 interpreta os valores em **passos de 0,5 dBm** — diferente do
LR1121, que usa dBm direto. Limites: LF −44..+44 (−22..+22 dBm), HF −39..+24
(−19,5..+12 dBm).

| nível ELRS | `power_values` (sub-GHz) | `power_values_dual` (2.4 GHz) |
|---|---|---|
| 10 mW | 20 → +10 dBm | 16 → +8 dBm |
| 25 mW | 28 → +14 dBm | 20 → +10 dBm |
| 50 mW | 34 → +17 dBm | 22 → +11 dBm |
| 100 mW | 40 → +20 dBm | 24 → **+12 dBm (teto do PA HF)** |

## Pendente

- [ ] Teste no ar contra o IHM (mesma frase, taxa no índice 9)
- [ ] Confirmar no datasheet da NiceRF qual DIO do LR2021 vai no pad de IRQ —
      os layouts assumem DIO9, o default do driver (`radio_rfsw_ctrl`)
- [ ] Confirmar `radio_dcdc` (está `false`) e `radio_tcxo` (está 0 = 1,6 V)
- [ ] Entradas de GFSK na tabela (ficaram de fora; só LoRa por ora)

## Cuidado com a versão

O travamento é no IHM: ele é OTA v3. Se um dia o transmissor comercial for
atualizado para ExpressLRS 4.x, ele para de funcionar com o IHM — e este
projeto também, se for junto. Manter em 3.6.4 enquanto o IHM for v3.
