# LoRa2021 — protótipo dual-band

> **Estado atual:** a placa está com o **firmware receptor ExpressLRS**, validado
> contra um transmissor ELRS 2.4 GHz — LQ 100%, RSSI −36 dBm, entregando canais
> RC por CRSF. Ver [`elrs/v3-lr2021/README.md`](elrs/v3-lr2021/README.md).
>
> Os dois firmwares deste repositório não coexistem na mesma placa: gravar a
> bancada apaga o receptor e vice-versa.
>
> **Configuração do módulo (medida, não suposta):**
> sem TCXO (cristal) · IRQ no **DIO9** · sem chave de antena.
>
> **Duas placas, o mesmo `src/` e `lib/`** — só muda a pinagem e a partition
> table, ambas nas build flags de cada env:
>
> | env | placa | pinagem |
> |---|---|---|
> | `esp32dev` | ESP32-WROOM-32 DevKit v1 (30 pinos) | `D13..D32` em fila única |
> | `esp32s3` | ESP32-S3 DevKitC-1 | igual à do SX1280 na IHM (40/38/41/39/42/1/2) |
>
> Justificativa pino a pino e diagrama de ligação em
> [`docs/PINOUT.md`](docs/PINOUT.md).

Módulo **G-NiceRF LoRa2021**, baseado no **Semtech LR2021** (4ª geração LoRa
Plus). Multi-banda num CI só:

| | faixa | sensibilidade |
|---|---|---|
| Sub-GHz | 410–510 / 850–930 MHz (chip: 150–1090) | −144 dBm @ BW 62,5 kHz SF12 |
| 2.4 GHz ISM | 2400–2500 MHz | −137 dBm @ BW 203,125 kHz SF12 |
| S-band (licenciada) | 1900–2200 MHz | −131 dBm @ BW 125 kHz SF10 |

Modulações: LoRa, (G)FSK, (G)MSK, **FLRC** (até 2,6 Mbps), 4-FSK, O-QPSK,
LR-FHSS (só TX). TX até +22 dBm em sub-GHz, +12 dBm em 2.4 GHz.

## Duas frentes

### Raiz — bancada de bring-up

Projeto PlatformIO ([platformio.ini](platformio.ini), [src/](src/), [lib/](lib/))
pra **validar o hardware** antes de qualquer coisa. Sem dependências externas: o
driver do LR2021 é deste repositório ([lib/LR2021/](lib/LR2021/)) — o porquê está
mais abaixo. Valida:
alimentação, SPI, BUSY/NRESET, TCXO e qual DIO é o IRQ. Dois nós iguais fazem
beacon e ping-pong, com console serial a 115200 pra trocar banda, frequência,
potência, SF/BW/CR em runtime.

```bash
pio run -t upload      # firmware   (env default: esp32dev)
pio run -t uploadfs    # painel web (data/ -> LittleFS)
pio device monitor

pio run -e esp32s3 -t upload       # a mesma bancada no S3
```

Comandos do console: `band 868|915|2g4|sband`, `freq`, `pwr`, `sf`, `bw`, `cr`,
`send`, `ping`, `stats`.

### Teste de alcance

Duas placas, o mesmo binário, papéis diferentes. O papel de fábrica vem do env
(`esp32dev` = RX, `esp32s3` = TX) e `role rx|tx` troca em runtime, gravando na
NVS — não há risco de compilar a errada.

O transmissor manda quadros numerados a 4 Hz. O receptor conta os buracos na
numeração, calcula **LQ** numa janela de 100 quadros e, a cada 20, devolve um
relatório com LQ/RSSI/SNR — então quem caminha com o transmissor lê o enlace
pelo ponto de vista do receptor, que é o que interessa medir.

```bash
pio run -e esp32dev -t upload   # receptor (ESP32 clássico)
pio run -e esp32s3  -t upload   # transmissor (S3)
```

Console: `role rx|tx`, `rate <ms>`, `stats`, `pwr <dBm>`.

**LED azul** (GPIO2 no ESP32 clássico), pra ler o estado do outro lado do campo:

| LED | significado |
|---|---|
| apagado | módulo LoRa2021 não encontrado |
| aceso | rádio ok, esperando o par |
| piscando | enlace vivo |

No S3 o LED fica desligado por padrão: o GPIO2 lá já leva o IRQ do módulo e o
LED de bordo é um WS2812 endereçável. Para ter status nele, solde um LED comum
num pino livre e defina `PIN_STATUS_LED` no env.

### Pares e rede de casamento

`peer <bancada2g4|bancada433|bancada|elrs2g4|elrs900>` escolhe o que está do
outro lado — e com ele a frequência e a modulação:

| par | frequência | modulação | para quê |
|---|---|---|---|
| `elrs2g4` | 2441,4 MHz | SF8 / 812,5 kHz / **4:8 LI** | **padrão** — escutar um transmissor ExpressLRS 2.4 GHz de verdade |
| `bancada2g4` | 2441,4 MHz | SF8 / 812,5 kHz / 4:8 | alcance em 2.4 GHz, na PHY do ExpressLRS |
| `bancada433` | 433,0 MHz | SF9 / 125 kHz / 4:7 | alcance em 433 MHz |
| `bancada` | 915,0 MHz | SF9 / 125 kHz / 4:7 | idem, para módulo casado em 915 |
| `elrs900` | 922,1 MHz | escuta, 8 B crus | idem em AU915 |

`bancada2g4` usa a frequência e a modulação do ExpressLRS 2.4 GHz de propósito:
assim o alcance medido tem com o que ser comparado, em vez de ser um número
solto. Ao contrário de `elrs2g4`, ele **decodifica** — as duas placas conversam.

#### Escuta do ExpressLRS: o que faz funcionar

O padrão de fábrica é `elrs2g4`, validado contra um transmissor comercial:

```
ELRS #1  16 00 8A 98 C9 8B ED EE [SYNC]  RSSI -36.0 dBm  SNR 16.2 dB
escuta ELRS: 78 pacotes demodulados, 7 passaram no CRC14
```

Os quatro bytes no meio (`98 C9 8B ED`) são o UID do transmissor. Três detalhes
custaram horas cada:

- **Interleaver LONGO.** O ExpressLRS usa `CR_LI_4_8` em todas as taxas de
  2.4 GHz — está na tabela em `elrs/ExpressLRS-v3/src/src/common.cpp`. Curto e
  longo são codificações diferentes: com o errado nada demodula, e a tela fica
  igual a "não há transmissor no ar". O perfil de par carrega isso no campo
  `longInterleaver`.
- **A taxa é o SF.** BW é sempre 800 kHz; o que muda é o fator de espalhamento —
  SF5 = 500 Hz, SF6 = 250, SF7 = 150, **SF8 = 50 Hz**. O comando `elrsscan`
  varre as seis e diz em qual o transmissor está, contando pacotes demodulados.
- **Crus e válidos são contadores separados.** Sem essa distinção, frase de
  binding errada e ausência de transmissor davam a mesma tela. Agora `stats`
  diz qual dos dois é.

O firmware também **para de transmitir** em modo escuta: o quadro da bancada
seria ruído na mesma frequência do sinal que se quer medir.

**Limite conhecido:** só o pacote **SYNC** é validável às cegas. O RCDATA em
modo wide carrega o nonce dentro do campo de CRC, e o nonce só se conhece depois
de sincronizar — o que é, na prática, ser um receptor ExpressLRS. Esta bancada
prova que o transmissor é audível e mede RSSI/SNR; para entregar canais RC
existe o firmware em [`elrs/v3-lr2021/`](elrs/v3-lr2021/).

#### Alternando 433 ↔ 2.4 GHz para comparar alcance

Um comando em cada placa, e fica gravado na NVS:

```
peer bancada433     # 433 MHz · SF9 / 125 kHz · 22 dBm · antena no pino 9
peer bancada2g4     # 2441,4 MHz · SF8 / 812,5 kHz · 12 dBm · antena no pino 10
```

Três coisas mudam junto com a frequência, e cada uma já mordeu este projeto:

- **A porta de RF.** São duas saídas independentes, sem chave. Antena na porta
  errada não gera erro nenhum — só encolhe o alcance. O banner de boot imprime
  em qual pino a antena vai.
- **A potência.** +22 dBm em 433, +12 dBm em 2.4 GHz — os dois são o teto do
  respectivo amplificador do LR2021, o de alta não passa de 12 dBm. A potência
  vem do perfil do par; sem isso, ir de 2.4 GHz para 433 mantinha os 12 dBm
  anteriores, e o teste de 433 rodaria 10 dB abaixo do que o rádio entrega.
- **A cadência.** `rate` é um teto, não uma promessa. Em SF9 / 125 kHz um quadro
  de 48 B ocupa **398 ms** de ar, então o firmware espaça as transmissões em
  4× o tempo no ar (1592 ms) — em 2.4 GHz, onde o quadro leva ~10 ms, os 250 ms
  pedidos valem como estão. O banner mostra as duas cifras.

**Comparação justa.** As duas configurações têm modulações diferentes: cada uma
é o ajuste razoável da sua banda, então o que se mede é *qual montagem vai mais
longe*, não o efeito puro da frequência. Para isolar a banda, iguale a modulação
nos dois lados em runtime: `bw 125`, `sf 9`, `cr 7`.

A rede de casamento sub-GHz é fechada na matriz de solda do módulo, e o firmware
guarda qual é na NVS (`match 150|433|470|868|915`). Os módulos deste protótipo
são **2.4G/433**, que é o padrão de primeira gravação; 915 continua na lista
para quando houver módulo casado nela. Transmitir fora da rede casada não gera
erro nenhum no log — só some alcance.

### Driver do LR2021

O rádio é acionado por [`lib/LR2021/`](lib/LR2021/), escrito direto sobre os
comandos do fabricante. O projeto não tem dependência externa nenhuma: o
`lib_deps` está vazio e o build não baixa nada.

Ter o driver em casa não foi preferência — foi necessidade. O que decide se um
enlace meia-duplex fecha é o **modo de fallback**: o estado em que o LR2021 cai
depois de cada transmissão e de cada recepção, escolhido por
`SetRxTxFallbackMode`.

Com `STANDBY_RC` — o estado mais frio, e o padrão de quem não configura — o chip
derruba o XOSC ao fim do TX, e voltar para recepção exige religar o oscilador e
re-sintonizar o PLL. Medido nesta bancada, em 2.4 GHz a 4 quadros por segundo:

| cenário | resultado |
|---|---|
| transmissor calado (`beacon off`) | recebe **3 de 3** |
| transmissor a 4 Hz | recebe **0 de dezenas**, com `rx_err = 0` |

O `rx_err = 0` é a parte que denuncia: o rádio não estava sequer ouvindo
preâmbulo entre uma transmissão e a seguinte. Watchdog de rearme, checar o
retorno de cada comando e forçar `standby()` antes de armar a escuta foram todos
testados — nenhum muda o número, porque nenhum toca na causa.

Este driver usa `FALLBACK_FS`, como o driver do ExpressLRS: o chip cai em
síntese de frequência, quente e já sintonizado, e volta para RX em
microssegundos. Com isso o enlace fecha nos dois sentidos e o receptor devolve
relatório ao transmissor sem perder um — e meia-duplex é justamente o que um
enlace de RC faz o tempo todo.

**Fontes.** Os opcodes e campos em `lr2021_regs.h` são o `lr20xx_radio_types.h`
da Semtech (Clear BSD, © Semtech 2021); `lr2021_pram.h` é o patch de PRAM
distribuído pela Semtech — o LR2021 sai de fábrica sem parte do firmware de
rádio, e o host o grava a cada boot. A sequência de init segue a numeração do
datasheet, citada passo a passo no código.

Dois detalhes custam horas se não estiverem escritos:

- **`SetDioFunction` antes de `SetDioIrqParams`.** O DIO só vira linha de
  interrupção depois de ser declarado como tal (`{DIO, 0x10}`). Sem esse passo o
  chip inicializa, transmite e recebe — e nenhuma interrupção chega ao MCU.
- **O LR2021 fica ~230 ms com o BUSY alto depois do reset.** Falar SPI antes
  disso devolve zeros e parece chip ausente.

### Quando o rádio não sobe

Se o rádio não subir, `wire` faz o teste elétrico dos sete fios e `scan` procura
SCK/MOSI/MISO em todos os pinos do header — o `wire` ainda roda sozinho no boot
quando a detecção devolve `CHIP_NOT_FOUND`. Como cada etapa fecha o cerco está
em [`docs/PINOUT.md`](docs/PINOUT.md).

#### Monitor serial

Existe em duas versões — **a mesma lógica**, uma no navegador e outra no
terminal:

```bash
python tools/serial/serve.py          # pagina web  -> http://localhost:8081
python tools/serial_app.py            # terminal, 420000, porta automatica
python tools/serial_app.py -b 115200  # terminal, console da bancada
python tools/serial_app.py --list     # portas disponiveis
```

A versão web ([`tools/serial/`](tools/serial/)) usa a **Web Serial API** e tem o
mesmo acabamento do painel de bordo: LQ em número grande com barra, RSSI, SNR,
potência do transmissor em mW e os 16 canais RC em barras com marca de centro e
valor em µs. Só Chrome e Edge no desktop; Firefox e Safari não implementam a API.
O `serve.py` existe porque alguns builds não expõem `navigator.serial` em
`file://`, e aí o botão de conectar falha sem dizer por quê.

**Ele reinicia a placa ao conectar, de propósito** (dá pra desmarcar). O receptor
ELRS fica **mudo** depois que o auto-WiFi sobe — medido: 0 byte em 12 s sem
reset, 30 kB em 26 s com reset. Sem reiniciar, abrir a porta não mostra nada e o
silêncio é indistinguível de app quebrado. Por isso também o botão **RESET**, que
pulsa DTR/RTS sem precisar reconectar: a telemetria só começa ~18 s após o boot.

Um app só serve aos dois firmwares porque eles não falam a mesma língua na mesma
UART: o receptor ExpressLRS manda **CRSF binário a 420000** e a bancada manda
**texto a 115200**. Os dois decidem sozinhos pelo conteúdo — se quadros CRSF
fecharem o CRC, abre a visão de enlace; senão viram terminal de texto, onde o
que você digitar vai para o console.

O padrão é 420000 de propósito: essa taxa não aparece na lista do PuTTY nem do
monitor da Arduino IDE, que é justamente por que ler o receptor com eles só
produz lixo.

#### Painel web

> **O WiFi se desliga sozinho depois de 2 minutos sem ninguém acessar**, e só
> volta com `reset` ou religando a placa. Basta um acesso dentro dessa janela
> para ele ficar de pé até o próximo boot.
>
> O motivo é medível: o rádio WiFi do ESP32 é 2,4 GHz, a mesma banda dos pares
> `bancada2g4` e `elrs2g4`. O access point dessensibiliza o próprio receptor da
> placa, e num teste de alcance isso penaliza o 2.4 GHz por um motivo que não
> tem nada a ver com a banda. Deixar o painel morrer sozinho resolve sem
> depender de alguém lembrar de desligá-lo no campo — e o que desliga é o
> transceptor inteiro (`WIFI_OFF`), não só o AP: um `softAPdisconnect` sozinho
> deixaria o rádio ligado.
>
> A janela está em `WebConfig::kApGraceMs`.

A placa sobe um ponto de acesso **`LoRa2021-<node>`** (senha `lora2021`) e serve
[`data/`](data/) em `http://192.168.4.1`. Dá pra fazer tudo que o console faz —
trocar banda, frequência, potência, SF/BW/CR, beacon, enviar e dar ping — com
leitura ao vivo de RSSI, SNR e contadores.

Feito como instrumento de bancada, com duas materialidades: a área de leitura é
**vidro** (bisel, vinheta, varredura ao ligar, brilho de fósforo) e o resto é
**chapa metálica** com controles, parafusos e serigrafia. Tem S-meter de
ponteiro, gráfico de RSSI dos últimos 90 s e o **tom do painel acompanha a
banda** — âmbar em sub-GHz, violeta na S-band, ciano em 2.4 GHz — que é a pista
mais rápida de em que faixa você está.

Sem webfont, sem CDN e sem framework: 35 kB no total, servidos offline pelo
próprio ESP32.

##### Ver sem gravar a placa

```bash
python tools/preview.py     # http://localhost:8080
```

Sobe a mesma página com a API simulada — RSSI oscilando, beacon andando,
contadores subindo. Serve pra mexer no visual sem regravar o ESP32 a cada
ajuste. Só biblioteca padrão.

| rota | o quê |
|---|---|
| `GET /api/state` | estado + estatísticas + registro |
| `POST /api/config` | `band`, `freq`, `bw`, `sf`, `cr`, `power`, `beacon`, `interval` |
| `POST /api/send` | `text` |
| `POST /api/ping` | mede ida e volta |

A ordem em que `/api/config` aplica os campos importa e é proposital: **banda
primeiro** (reescreve tudo de uma vez) e **potência por último**, porque o
limite do PA muda com a faixa e ela precisa ser validada contra a frequência que
acabou de valer.

### [`elrs/`](elrs/) — link RC ExpressLRS

Duas bases, para dois alvos diferentes:

| pasta | base | para quê |
|---|---|---|
| [`elrs/v3-lr2021/`](elrs/v3-lr2021/) | **ExpressLRS 3.6.4** (OTA v3) | conversar com o **IHM** e com transmissores comerciais ELRS 3.x. **TX e RX compilam.** |
| [`elrs/`](elrs/) (raiz) | branch do [PR #3697](https://github.com/ExpressLRS/ExpressLRS/pull/3697) (4.2, OTA v4) | ELRS mais novo, se um dia o IHM migrar |

O IHM usa OTA v3, e é ele que trava a versão — por isso a base principal é a
3.6.4. Ver [`elrs/v3-lr2021/README.md`](elrs/v3-lr2021/README.md).

A pinagem ESP32↔LoRa2021 é a mesma nas duas frentes, de propósito: valide na
bancada, depois flashe o ELRS na mesma placa.

## Referências

- [Semtech LR2021](https://www.semtech.com/products/wireless-rf/lora-plus/lr2021) · [datasheet (Mouser)](https://www.mouser.com/pdfDocs/61979758LR2021_V1_1_datasheet.pdf)
- [G-NiceRF LoRa2021](https://www.nicerf.com/lora-module/lora2021.html)
- [ExpressLRS PR #3697](https://github.com/ExpressLRS/ExpressLRS/pull/3697)
