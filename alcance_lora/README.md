# Alcance LoRa

App de campo para levantar o **raio de alcance** do enlace LoRa2021: caminha-se
com o celular ligado à placa por USB, e cada ponto do trajeto guarda coordenada,
altitude, distância até o transmissor e RSSI.

Derivado do [`../gps_rastreador`](../gps_rastreador) — mesma base React + Vite +
Capacitor + Leaflet, mesmo padrão de Supabase.

## As duas telas

**Principal** — três caminhos, como pedido:

| | o que faz |
|---|---|
| **Tempo real** | abre a serial, lê o rádio e o GPS, e vai marcando o trajeto |
| **Salvar como…** | grava a sessão atual no banco do aparelho, com nome |
| **Abrir** | lista as campanhas salvas; abre no mapa, exporta ou apaga |

**Mapa** — só o mapa. Pontos coloridos por RSSI (verde −40 dBm → vermelho
−120 dBm), contorno vermelho onde o enlace caiu, trilha ligando o percurso,
marcador azul no transmissor e anéis de 250 m, 500 m, 1 km e 2 km para dar
escala. No rodapé: alcance útil, ponto mais distante, RSSI atual e contagem.

## Como os dados chegam

A placa fala **115200 pela USB**. O firmware emite, a cada 5 s e sob o comando
`tel`, uma linha de telemetria:

```
$T t=15838 link=1 rssi=-36.0 snr=12.2 lq=100 rx=9 lost=0 freq=433.000 band=433 sf=9 bw=125.00 pwr=22 role=rx
```

O prefixo `$T` existe para essa linha conviver com o resto do log: o app ignora
qualquer linha que não comece com ele, então mensagens de diagnóstico no meio
não quebram a leitura. O resumo humano (`LQ 100% | RSSI -40.0 dBm | …`) continua
saindo para quem estiver olhando o monitor — ele é ótimo para ler e péssimo como
contrato de máquina, que é justamente por que a `$T` foi criada.

Dois transportes, mesma interface:

- **Android** — plugin `@adeunis/capacitor-serial` (CDC/ACM). Exige aceitar o
  pedido de permissão do cabo na primeira vez.
- **Navegador de mesa** — Web Serial, para desenvolver sem o celular. Não existe
  no Chrome do Android, e é por isso que o plugin é necessário.

USB em vez do painel WiFi de propósito: conectado ao AP da placa o celular fica
**sem internet**, e uma campanha inteira offline atrapalha. Por cabo os dados
móveis seguem de pé.

## Distância

Precisa de uma origem: **Marcar aqui como transmissor**, com o celular ao lado
da placa transmissora antes de sair. Sem isso os pontos são gravados, mas sem
distância.

O cálculo é 3D — Haversine no plano mais o desnível. Num teste de alcance a
altura importa: 100 m de subida com 300 m de afastamento horizontal dão 316 m de
caminho real, e é esse número que explica o RSSI.

A distância é gravada **junto com cada amostra**, não calculada na exibição. A
origem pode ser corrigida depois, e recalcular faria o histórico mostrar
distâncias que nunca foram medidas em campo.

Amostras com precisão de GPS pior que **50 m** são descartadas: acima disso o
aparelho normalmente está usando rede em vez de satélite, e a posição erra
quarteirões — inventando cobertura onde não há.

## Banco de dados

**No aparelho (sempre):** IndexedDB. É a gravação primária, e é o que faz o app
funcionar no meio do mato. Não é localStorage porque uma campanha de uma hora a
1 amostra/s são ~3600 pontos, e algumas delas passam do limite de ~5 MB — que
estoura em silêncio, perdendo justamente a campanha mais longa.

**Na nuvem (opcional):** Supabase. Rode [`supabase-schema.sql`](supabase-schema.sql)
e preencha `.env.local` a partir de `.env.local.example`. Sem isso o app funciona
por completo, só não consolida campanhas de vários aparelhos.

Duas tabelas: `range_sessions` (uma linha por campanha, com banda, potência e a
origem) e `range_samples` (os pontos). Separadas porque os metadados não se
repetem por ponto — e guardá-los em cada amostra permitiria que duas linhas da
mesma campanha discordassem sobre onde estava o transmissor.

O envio é idempotente pelo `local_id`, então repetir depois de uma queda de rede
no meio do caminho não duplica nada. A view `range_session_summary` traz o
resumo sem baixar as amostras, incluindo `linked_distance_m` — a maior distância
em que **ainda havia enlace**, que é o número que responde "até onde foi" e não
coincide com o ponto mais distante quando se continuou andando depois de perder
o sinal.

## Exportar

Cada campanha sai em **GeoJSON** (abre direto em QGIS e Google Earth) ou **CSV**
(para o gráfico RSSI × distância na planilha). Serve para a campanha não ficar
presa dentro do app.

## Rodar

```bash
npm install
npm run dev          # navegador, com Web Serial
npm run android      # build + cap sync + abre o Android Studio
```

Na primeira vez no Android:

```bash
npx cap add android
```

O projeto está em **Capacitor 8** — o plugin de serial só existe a partir dessa
versão. O `gps_rastreador` segue na 7 e não é afetado; são projetos separados.
