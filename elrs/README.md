# ExpressLRS no LoRa2021 (Semtech LR2021)

Alvo: link RC dual-band (sub-GHz + 2.4 GHz) rodando ExpressLRS num ESP32 com o
módulo **G-NiceRF LoRa2021**.

## Estado do suporte upstream

| Onde | Status |
|---|---|
| ELRS 4.1.0 (estável, jul/2026) | ❌ só SX127x, SX1280, LR1121 |
| ELRS 4.0.0 (fev/2026) | ⚙️ "Core Refactoring for LR2021" — generalizou os RF paths |
| [PR #3697](https://github.com/ExpressLRS/ExpressLRS/pull/3697) — `pkendall64:4.2/lr2021` | ✅ `src/lib/LR2021Driver` completo, envs prontas |

O PR está **aberto** (desde 12/jul/2026, 33 commits). O autor sinaliza que a
configuração de potência (`PA_LF_DUTY_CYCLE`, `PA_HF_DUTY_CYCLE`,
`PA_LF_SLICES`) ainda não está finalizada, e que módulos de terceiros são
"unsupported hardware" até serem testados pelo time.

O LR2021 é o primeiro chip que cobre **todos** os modos do ELRS num CI só:
LoRa, FSK e FLRC, em sub-GHz (compatível SX127x/LR1121) e 2.4 GHz (compatível
SX1280/LR1121) — dá cross-band com RX legado.

## O que tem aqui

```
elrs/
├── setup_hardware.py              prepara a árvore de build (idempotente)
├── user_defines.txt               domínio regulatório + flags de debug
├── hardware/
│   ├── targets.partial.json       entrada "lora2021" mesclada no targets.json
│   ├── TX/LoRa2021 ESP32.json     layout de pinos do TX
│   └── RX/LoRa2021 ESP32.json     layout de pinos do RX
└── ExpressLRS/                    clone da branch 4.2/lr2021 (não versionar)
```

Tudo que é nosso fica **fora** do clone; o `setup_hardware.py` copia pra dentro.
Assim `git pull` no ExpressLRS não conflita — é só rodar o script de novo.

## Setup

```bash
git clone --depth 1 --branch 4.2/lr2021 \
    https://github.com/pkendall64/ExpressLRS.git elrs/ExpressLRS

python elrs/setup_hardware.py
```

O `setup_hardware.py` clona o repo **ExpressLRS/targets** em
`ExpressLRS/src/hardware` (o firmware "Unified" lê o layout de pinos de lá, não
de compile-time), copia os layouts daqui, mescla a entrada `lora2021` no
`targets.json` e instala o `user_defines.txt`.

O domínio regulatório é **obrigatório** — o ELRS trata o LR2021 como rádio
sub-GHz e aborta o build sem ele. Está em `user_defines.txt` como
`-DRegulatory_Domain_AU_915` (plano de 915 MHz usado no Brasil).

## Build

```bash
cd elrs/ExpressLRS/src

# TX (módulo pro rádio, CRSF por UART)
pio run -e Unified_ESP32_LR2021_TX_via_UART
python python/binary_configurator.py \
    --target lora2021.tx_dual.esp32 \
    --phrase "sua bind phrase" --tx \
    .pio/build/Unified_ESP32_LR2021_TX_via_UART/firmware.bin

# RX
pio run -e Unified_ESP32_LR2021_RX_via_UART
python python/binary_configurator.py \
    --target lora2021.rx_dual.esp32 \
    --phrase "sua bind phrase" \
    .pio/build/Unified_ESP32_LR2021_RX_via_UART/firmware.bin
```

Envs disponíveis na branch: `Unified_ESP32_LR2021_{TX,RX}_via_*`, mais as
variantes `Unified_ESP32C3_*` e `Unified_ESP32S3_*`.

## Pinagem (ESP32-WROOM-32, VSPI)

| LoRa2021 | ESP32 | campo no layout |
|---|---|---|
| SCK | 18 | `radio_sck` |
| MISO | 19 | `radio_miso` |
| MOSI | 23 | `radio_mosi` |
| NSS | 5 | `radio_nss` |
| NRESET | 25 | `radio_rst` |
| BUSY | 27 | `radio_busy` |
| IRQ | 26 | `radio_dio1` |
| ANT1 | — | antena sub-GHz |
| ANT2 | — | antena 2.4 GHz |
| CRSF RX/TX | 3 / 1 | `serial_rx` / `serial_tx` |

Mesma pinagem do projeto de bancada na raiz do repositório, de propósito: valide
o hardware lá antes de entrar no ELRS.

## RF switch — `radio_rfsw_ctrl`

O driver do ELRS configura os DIO5–DIO11 **do LR2021** (não do ESP32) como
controle de RF switch. Os 7 valores do array são bitmask de estado:

```
bit 4 = TX 2.4    bit 3 = RX 2.4    bit 2 = TX subG    bit 1 = RX subG    bit 0 = standby
0xFF = usar este DIO como pino de IRQ
```

Default do driver (e o que está nos layouts daqui):

```json
"radio_rfsw_ctrl": [16, 8, 4, 2, 255, 0, 0]
```

| DIO | valor | função |
|---|---|---|
| DIO5 | `0x10` | TX 2.4 GHz |
| DIO6 | `0x08` | RX 2.4 GHz |
| DIO7 | `0x04` | TX sub-GHz |
| DIO8 | `0x02` | RX sub-GHz |
| DIO9 | `0xFF` | **IRQ** |
| DIO10/11 | `0x00` | não usados |

## Potência — atenção às unidades

`power_values` do **LR2021 é em passos de 0,5 dBm**, diferente do LR1121 (que é
dBm direto). Limites do driver:

```
LF (sub-GHz)  -44 .. +44   →  -22 .. +22 dBm
HF (2.4 GHz)  -39 .. +24   →  -19,5 .. +12 dBm
```

Nos layouts daqui:

| nível ELRS | `power_values` (sub-GHz) | `power_values_dual` (2.4 GHz) |
|---|---|---|
| 10 mW | 20 → +10 dBm | 16 → +8 dBm |
| 25 mW | 28 → +14 dBm | 20 → +10 dBm |
| 50 mW | 34 → +17 dBm | 22 → +11 dBm |
| 100 mW | 40 → +20 dBm | 24 → **+12 dBm (teto do PA HF)** |

O PA de 2.4 GHz do LR2021 satura em **+12 dBm (~16 mW)**. Pra alcance de ELRS
2.4G típico (100 mW) precisa de PA externo — ou usar a versão
**LoRa2021F33-2G4** (2 W) com `power_txen` / `power_rxen` no layout.

## Compatibilidade com o IHM_esp32

O projeto `D:\Projetos\Projetos_2026\IHM_esp32_30_07_26\IHM_esp32` **não** fala
CRSF por UART com um módulo externo: ele embute uma cópia enxuta da stack de
rádio do ExpressLRS (`lib/ELRSRadio/`, derivada do ELRS **3.x**) e controla um
**SX1280** direto por SPI3, implementando os dois papéis (TX e RX) do protocolo
OTA. Então a compatibilidade aqui é **no ar**, não no fio.

### Já bate

| item | IHM_esp32 | LR2021 (ELRS 4.2) |
|---|---|---|
| Derivação da bind phrase | `md5('-DMY_BINDING_PHRASE="<frase>"')[0:6]` | idêntico |
| Tabela FHSS 2.4 GHz | 2400,4–2479,4 MHz, 80 canais | idêntico |
| Polinômios CRC | CRC14 `0x2E57` / CRC16 `0x3D65` | idêntico |
| Tamanho de pacote | OTA4 = 8 B / OTA8 = 13 B | idêntico |
| Modo de switch | `smWideOr8ch` | `smWideOr8ch` existe |
| Escala de canal | 172 / 992 / 1811 | idêntico |

**Bind phrase em uso: `Paulo_Palaoro`** (em `Telas/lora_lrs.json:29` e
`Telas/lora_lrs_trans.json:29`, runtime, não build flag).

```
md5('-DMY_BINDING_PHRASE="Paulo_Palaoro"')[0:6]
  = 151,169,239,201,139,237
  = 97 A9 EF C9 8B ED
```

No lado ELRS é só passar `--phrase "Paulo_Palaoro"` no `binary_configurator`,
que gera exatamente esse UID.

### Taxa equivalente

O IHM usa `rateIndex: 9` da tabela dele (50 Hz). O índice **não** é o mesmo nas
duas tabelas — o LR2021 tem 24 taxas em outra ordem. O equivalente é o
**índice 21, `RATE_LORA_2G4_50HZ`**, e a modulação é idêntica:

```
BW 800 kHz · SF8 · CR LI 4/8 · TLM 1:16 · hop 2 · 20000 µs · OTA4 (8 B)
```

O IHM aceita só os índices 4–9 dele (FLRC/DVDA não foram portados), e as taxas
`LORA_DUAL` do LR2021 (22/23) não têm equivalente — evite.

### Bloqueios reais

1. **`OTA_VERSION_ID`: IHM = 3, ELRS 4.2 = 4.** Esse byte é XORado na semente do
   FHSS *e* no inicializador do CRC. Com a mesma frase:

   | | semente FHSS | init CRC |
   |---|---|---|
   | ID 3 (IHM) | `0xEFC98BEE` | `0x8BEE` |
   | ID 4 (ELRS 4.2) | `0xEFC98BE9` | `0x8BE9` |

   Sequência de salto diferente e CRC diferente → o receptor demodula tudo e
   reprova 100% dos pacotes.

2. **O pacote SYNC mudou de layout entre 3.x e 4.x.** Mesmos 6 bytes, campos
   diferentes:

   ```c
   // IHM (ELRS 3.x)
   { fhssIndex, nonce, {switchEncMode:1, newTlmRatio:3, rateIndex:4},
     UID3, UID4, UID5 }

   // ELRS 4.x
   { fhssIndex, nonce, rfRateEnum,
     {switchEncMode:1, newTlmRatio:3, geminiMode:1, otaProtocol:2, free:1},
     UID4, UID5 }
   ```

   O `rateIndex` de 4 bits virou um byte inteiro `rfRateEnum` — justamente
   porque o LR2021 tem 24 taxas e 4 bits só endereçam 16. `UID3` saiu do sync.

3. **Tipos de pacote divergem no downlink**: no 3.x `0b01 = MSPDATA`; no 4.x
   `0b01 = DATA` e `0b00 = LINKSTATS` (no sentido de volta).

4. **Telemetria**: o IHM força `TLM_RATIO_NO_TLM` (link só de ida). O lado ELRS
   precisa ficar com telemetria desligada, senão gasta slot esperando resposta.

5. **Model match**: o IHM não usa (`MODELMATCH_MASK` existe mas nunca é
   referenciado). Tem que ficar off nos dois lados.

6. **Potência**: o IHM trava no mínimo do SX1280 (−18 dBm) e nunca sobe. O PA HF
   do LR2021 vai de −19,5 a +12 dBm — dá pra casar, mas os `power_values_dual`
   deste repositório começam em +8 dBm.

### Estado do port: PARCIAL — ainda não interopera

O caminho escolhido foi subir o **IHM para o OTA v4** — o inverso (segurar o
ELRS no v3) não fecha, porque o `rateIndex` de 4 bits do sync v3 não endereça as
24 taxas do LR2021.

A primeira leva de mudanças (abaixo) resolveu versionamento, pacote SYNC e enum
de taxas. Uma auditoria posterior, arquivo por arquivo, achou **mais cinco
divergências** no caminho de RCDATA, no CRC e no FHSS — ver
[Pendências](#pendências-para-interoperar-de-fato). Do jeito que está, os dois
lados **não fecham link**.

Mudanças já aplicadas em `D:\Projetos\Projetos_2026\IHM_esp32_30_07_26\IHM_esp32`:

| arquivo | mudança |
|---|---|
| `lib/ELRSRadio/common.h` | `OTA_VERSION_ID` 3 → **4** |
| `lib/ELRSRadio/common.h` | `expresslrs_RFrates_e` renumerado pro esquema 4.x (sub-GHz 0–19, 2.4 GHz 20–39, dual 100+) — agora é **valor de fio** |
| `lib/ELRSRadio/common.h` | `RATE_BINDING` → `RATE_LORA_900_50HZ` / `RATE_LORA_2G4_50HZ` |
| `lib/ELRSRadio/common.cpp` | tabelas de taxa migradas pros nomes qualificados por banda; fallback do `enumRatetoIndex` cobre 25 Hz das duas bandas |
| `lib/ELRSRadio/OTA.h` | novo `OTA_Sync_s` (`rfRateEnum`, `geminiMode`, `otaProtocol`; sem `UID3`) |
| `lib/ELRSRadio/OTA.h` | `PACKET_TYPE_MSPDATA` → `PACKET_TYPE_DATA` (semântica v4) |
| `src/lora_radio.cpp` | `loraFillSyncPacket` preenche o layout v4 |
| `src/lora_radio.cpp` | filtro de sync agora é `UID4` + 2 bits altos de `UID5`, igual ao `ProcessRfPacket_SYNC` do ELRS 4.x |

Um bug de interoperabilidade apareceu no caminho e foi junto: o
`switchEncMode` estava sendo escrito **invertido**
(`OtaSwitchModeCurrent == smWideOr8ch ? 1 : 0`, ou seja 1 pra modo *wide*),
quando o ExpressLRS compara o campo direto contra o `OtaSwitchModeCurrent` dele
(`smWideOr8ch == 0`). Nunca incomodou porque os dois lados do IHM travam
`smWideOr8ch` na mão, mas quebraria contra qualquer peer ELRS real.

Do lado do LoRa2021, trave a taxa no **índice 21 (`RATE_LORA_2G4_50HZ`)** pra
casar com o `rateIndex: 9` dos layouts do IHM.

### Pendências para interoperar de fato

Auditoria de `lib/ELRSRadio/` do IHM contra `pkendall64/ExpressLRS@4.2/lr2021`:

**1. Canal de sync do FHSS — 41 vs 40**

```c
// IHM  (lib/ELRSRadio/FHSS.cpp)   sync_channel = (freq_count / 2) + 1;  // 41
// 4.x  (lib/FHSS/FHSS.cpp:96)     sync_channel =  freq_count / 2;       // 40
```

O `+1` foi removido upstream. Muda a frequência de sync **e** a sequência de
salto inteira (o canal de sync semeia o array antes do embaralhamento). Este
sozinho já impede qualquer contato: os dois nem escutam na mesma frequência.

O resto do FHSS confere — mesmo algoritmo de embaralhamento, mesmo RNG (LCG
`a=214013, c=2531011, m=2^31`), 80 canais em 2400,4–2479,4 MHz, 240 entradas de
sequência (`(256/80)*80` dos dois lados). O LR2021 usa a tabela `domainsDualBand`
com `FHSSusePrimaryFreqBand = false` nas taxas 2G4, o que dá a mesma grade.

**2. Esquema de CRC**

```c
// IHM (v3): nonce entra nos BYTES do pacote, inicializador limpo
crcHigh = (OtaNonce % FHSShopInterval) + 1;      // só RCDATA em modo wide
crc = calc(pkt, len, OtaCrcInitializer);

// 4.x: nonce entra no INICIALIZADOR, crcHigh zerado no cálculo
nonceValidator = (type == SYNC) ? 0 : OtaNonce;
crc = calc(pkt, len, OtaCrcInitializer ^ nonceValidator);
```

Efeito perverso: o **SYNC passaria** (nos dois casos crcHigh=0 e inicializador
limpo), mas **todo RCDATA seria reprovado**. Ou seja, o link pareceria conectar
e não passaria nenhum canal.

**3. `rc.ch4` virou `rc.isArmed`** — mesmo bit, significado diferente. No v3 era
o bit de CH5; no v4 é o status de armado, e o RX escreve `channelData[4]` a
partir dele.

**4. Bit 6 do byte `switches`** — no v3 é o *telemetry status*; no v4 é
`stubbornAck`.

**5. Resolução dos AUX em modo wide**

```c
// IHM (v3): 7 bits (128 bins), caindo pra 6 só quando telemInEveryPacket
// 4.x:      sempre 6 bits (64 bins)
```

#### Recomendação: re-vendorizar em vez de continuar remendando

Cada uma dessas só apareceu na inspeção — o código compila e roda igual dos dois
lados. Continuar corrigindo campo a campo é apostar que não existe uma sexta.

O caminho seguro é **substituir `lib/ELRSRadio/` pelos arquivos da branch
4.2/lr2021**. A superfície de dependência é pequena:

- `OTA.h` precisa de `crc.h`, `crsf_protocol.h`, `telemetry_protocol.h`,
  `FIFO.h` — todos já existem na cópia do IHM
- `OTA.cpp` precisa do global `linkStats` (o IHM tem `CRSF::LinkStatistics` no
  shim `devCRSF.h` — é renomear) e define seu próprio `isArmed`
- `FHSS.cpp/h` precisa de `logging.h`, `options.h`, `targets.h`, `random.h` +
  um header de driver (fica no ramo `SX1280Driver.h`)

Ou seja: trocar `OTA.*`, `FHSS.*`, `common.*`, `crc.*`, `random.*` pelos do 4.2 e
ajustar o shim do `devCRSF`. Depois disso o `src/lora_radio.cpp` precisa de
retoque nas chamadas de `OtaPackChannelData` (a assinatura perdeu
`TelemetryStatus`/`tlmDenom` e ganhou `stubbornAck`).

## Verificar antes de ligar

1. **Qual DIO do LR2021 vai no pad de IRQ do módulo.** Os layouts assumem DIO9
   (default do driver). Se o LoRa2021 rotear outro, mude a posição do `255` no
   `radio_rfsw_ctrl`. Confirme no datasheet da NiceRF — não consegui extrair a
   tabela de pinos do PDF deles (é imagem).
2. **`radio_dcdc`** está `false`. Só ligue pra `true` se o módulo tiver o
   indutor no VREG; sem ele, o chip trava.
3. **`radio_tcxo: 0`** = 1,6 V (encoding do LR11xx, que o driver repassa cru).
   Tabela: `0`=1,6V `1`=1,7V `2`=1,8V `3`=2,2V `4`=2,4V `5`=2,7V `6`=3,0V
   `7`=3,3V. `radio_tcxo_delay: 300` ≈ 9 ms (passos de 30,52 µs).
4. **Domínio regulatório** — no Brasil, sub-GHz é 915 MHz
   (902–907,5 / 915–928 MHz): use `Regulatory_Domain_AU_915` ou
   `FCC_915`. 2.4 GHz é livre.
5. **UART0 (GPIO 1/3) é o CRSF** — conflita com o USB do devkit. Pra debug use
   `via_WIFI` ou realoque `serial_rx`/`serial_tx`.
