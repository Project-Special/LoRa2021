# Ligação do LoRa2021 no ESP32

Duas placas usam o mesmo `src/` e `lib/`; a pinagem vem das build flags do
[platformio.ini](../platformio.ini).

| sinal | pino do módulo | `esp32s3` | `esp32dev` |
|---|---|---|---|
| MISO | 3  | 38 | 27 (`D27`) |
| MOSI | 4  | 41 | 13 (`D13`) |
| SCK  | 5  | 40 | 14 (`D14`) |
| NSS  | 6  | 39 | 26 (`D26`) |
| BUSY | 7  | 1  | 33 (`D33`) |
| RST  | 14 | 42 | 25 (`D25`) |
| DIO9 | 15 | 2  | 32 (`D32`) |

A do **S3** é a mesma do SX1280 na IHM (`Telas/lora_lrs.json`), pra o LoRa2021
entrar na fiação que já existe. O resto deste documento é sobre a do **ESP32
clássico**, que foi escolhida do zero.

---

## ESP32 DevKit v1 (30 pinos) — tudo numa fileira só

Placa: ESP32-WROOM-32 (D0WD-V3), ponte USB micro-B.
Header esquerdo `3V3 GND D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23`,
header direito `VIN GND D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN`.

Os 7 sinais saem em sequência no **header direito**, de `D13` até `D32`,
pulando apenas `D12`. Um flat de 8 vias resolve a ligação inteira, e a
alimentação sai do `GND` que fica no topo dessa mesma fileira.

```
        ESP32 DevKit v1                       LoRa2021 (LR2021)
   ┌──────────────────────────┐
   │ ...                      │
   │ VIN ─── (5 V, não usar)  │
   │ GND ────────────────────────────────────► GND   (pinos 2, 8, 11, 12, 18)
   │ D13 ────────────────────────────────────► MOSI  (pino 4)
   │ D12 ─── PULAR (strapping)│
   │ D14 ────────────────────────────────────► SCK   (pino 5)
   │ D27 ◄──────────────────────────────────── MISO  (pino 3)
   │ D26 ────────────────────────────────────► NSS   (pino 6)
   │ D25 ────────────────────────────────────► RST   (pino 14)
   │ D33 ◄──────────────────────────────────── BUSY  (pino 7)
   │ D32 ◄──────────────────────────────────── DIO9  (pino 15)
   │ D35 ─── livre            │
   │ D34 ─── livre            │
   └──────────────────────────┘
     3V3 (header esquerdo) ─────────────────► VCC   (pino 1)
```

Não conectar: **VTCXO (pino 13)** é *saída*, existe pra alimentar um TCXO
externo. Este módulo sai com cristal, e por isso `LR2021_TCXO_VOLTAGE=0`.
**DIO7 (17)** e **DIO8 (16)** ficam livres — qual DIO vira IRQ é escolhido por
SPI, e o firmware usa o DIO9 (`LR2021_IRQ_DIO_NUM=9`).

## Por que esses pinos

**Por que não a VSPI clássica (18/19/23/5).** Esses quatro estão espalhados no
header esquerdo com `RX0`/`TX0` no meio — os pinos do console USB, que não dá
pra ocupar. A fiação sairia em zigue-zague e ainda precisaria de mais três
pinos avulsos pra RST/BUSY/IRQ.

**Não usar os pinos nativos de SPI não custa nada.** O ESP32 tem matriz de
GPIO: qualquer periférico sai em qualquer pino. A rota direta (IO_MUX) só faz
diferença acima de ~40 MHz; aqui o barramento roda a 8 MHz
(`LORA_SPI_FREQUENCY`), com margem de sobra pra fio dupont.

**Pinos evitados, e o motivo:**

| pino | motivo |
|---|---|
| `D12` (GPIO12, MTDI) | **strapping**: se estiver alto no boot o ESP32 assume flash de 1,8 V e não sobe. `BUSY` do LR2021 pode estar alto na energização — é justamente o caso que trava a placa. |
| `D15` (GPIO15) | strapping (precisa ficar alto no boot; baixo silencia o log de boot). |
| `D2` (GPIO2) | strapping + LED da placa. |
| `RX0`/`TX0` (3/1) | console USB — é por onde sai o monitor serial e a gravação. |
| `D34` `D35` `VP` `VN` | **só entrada**, sem pull interno. Serviriam pra BUSY/IRQ, mas não pra nada que o ESP32 precise acionar. Ficam de reserva. |
| GPIO 6–11 | ligados à flash SPI interna, nem chegam ao header. |

`D13`/`D14` também são JTAG (MTCK/MTMS), mas isso só importa se você for
depurar por JTAG — o que não é o caso aqui.

## Alimentação

O módulo aceita 1,8–3,6 V; use o pino **3V3**, nunca o `VIN` (5 V). O pico é
em TX sub-GHz a +22 dBm — o datasheet fala em menos de 120 mA a 433 MHz, e o
AMS1117 da DevKit dá conta. Ainda assim, ponha **10–100 µF perto do módulo**,
somado ao 100 nF: o transiente do TX é rápido, e cabo dupont tem indutância
suficiente pra derrubar o rail e resetar o rádio no meio de um envio.

## Antenas

São duas portas de RF independentes, sem chave de antena:

- **pino 9 (ANT)** — sub-GHz, 50 Ω → 433/470/868/915 MHz
- **pino 10 (2.4G/S_ANT)** — 2,4 GHz ISM e banda S

A rede de casamento sub-GHz é fechada na matriz de solda do próprio módulo:
o firmware guarda essa informação na NVS (comando `match`), porque é
característica física da placa e não ajuste de rádio.

---

## Diagnóstico: `wire` e `scan`

Quando o rádio não sobe, o console tem dois comandos — e o `wire` roda sozinho
no boot se a detecção devolver `CHIP_NOT_FOUND`, que é quase sempre fiação.

```
wire    teste elétrico dos 7 fios, sem falar SPI de verdade
scan    varre SCK/MOSI/MISO por todos os pinos do header procurando o chip
```

O `wire` vai fechando o cerco em cinco etapas, cada uma usando o que a anterior
provou:

| etapa | o que prova |
|---|---|
| pull-up/pull-down em cada pino | fio solto, ou preso em GND/3V3 |
| dirigir as 4 saídas e reler | curto duro |
| pulso no NRESET olhando o BUSY | **módulo alimentado e vivo** — o BUSY sobe e cai sozinho |
| duração do BUSY num pulso de NSS | dezenas de µs = NSS chega; ~o mesmo do reset = esse fio está no NRESET |
| três comandos diferentes, respostas comparadas | se as respostas forem idênticas, o **MOSI** não chega |

A última etapa é a que fecha o caso quando tudo mais parece bom. Um chip que
recebe o comando responde coisas diferentes para comandos diferentes; se
`GET_VERSION`, `GET_ERRORS` e `GET_STATUS` voltam byte a byte iguais, o módulo
está recebendo a mesma coisa dos três — nada — e o defeito é o MOSI.

Dois detalhes que custam tempo se não estiverem escritos:

- **O LR2021 fica ~230 ms com o BUSY alto depois do reset.** O driver do
  ExpressLRS espera 300 ms por isso
  (`elrs/v3-lr2021/lib/LR2021Driver/LR2021_hal.cpp`), e o driver deste projeto
  também (`LR2021Chip::hardReset`). Qualquer teste caseiro que fale SPI antes
  disso lê zeros e acusa fiação errada numa placa boa.
- **A resposta tem dois bytes de status na frente.** `GET_VERSION` bom é
  `xx xx 01 18` (versão 1.24) — é assim que o ExpressLRS confere
  (`LR2021Driver::CheckVersion`). Ler a versão no offset 0 dá sempre lixo.
