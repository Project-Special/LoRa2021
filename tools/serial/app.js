/* =============================================================================
   LoRa2021 — monitor serial via Web Serial API.

   A UART do projeto carrega duas coisas incompatíveis, e nenhum monitor comum
   dá conta das duas:

       receptor ExpressLRS   CRSF binário a 420000 baud
       firmware de bancada   texto a 115200, com console interativo

   Então esta página abre em 420000, olha o que chega e decide sozinha qual
   visão mostrar. Espelha tools/serial_app.py — mesma lógica, mesma armadilha
   evitada (ver detectMode).
   ========================================================================== */

'use strict';

const TYPE_LINK = 0x14;
const TYPE_RC = 0x16;
const ADDRESSES = new Set([0xC8, 0xEA, 0xEC, 0xEE]);

// Índice do campo uplink_TX_Power do CRSF -> mW
const TX_POWER_MW = [0, 10, 25, 100, 500, 1000, 2000, 250, 50];

// CRC-8/DVB-S2, polinômio 0xD5 — o do CRSF. Tabela porque isso roda por quadro.
const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0xD5) & 0xFF : (c << 1) & 0xFF;
    t[i] = c;
  }
  return t;
})();

function crc8(data, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ data[i]];
  return c;
}

/** 16 canais de 11 bits empacotados em 22 bytes, little-endian contínuo. */
function unpackChannels(buf, at) {
  const out = new Array(16);
  let bitPos = 0;
  for (let i = 0; i < 16; i++) {
    const byte = at + (bitPos >> 3);
    const shift = bitPos & 7;
    const raw = buf[byte] | (buf[byte + 1] << 8) | (buf[byte + 2] << 16);
    out[i] = (raw >> shift) & 0x7FF;
    bitPos += 11;
  }
  return out;
}

/** Escala do CRSF (172..1811, centro 992) para µs de servo (988..2012). */
const toMicroseconds = (v) => Math.round((v - 992) * 5 / 8 + 1500);

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const S = {
  port: null,
  reader: null,
  writer: null,
  keepReading: false,

  buf: new Uint8Array(0),
  mode: '?',            // '?' | 'crsf' | 'text'
  decoder: new TextDecoder('utf-8', { fatal: false }),
  textTail: '',

  lastData: 0,
  connectedAt: 0,
  bytesWindow: [],
  rcFrames: 0,
  linkFrames: 0,
  crcErrors: 0,
  link: null,
  channels: [],

  logLines: [],
  dirty: true,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Buffer + parsing
// ---------------------------------------------------------------------------

function appendBuf(chunk) {
  const merged = new Uint8Array(S.buf.length + chunk.length);
  merged.set(S.buf, 0);
  merged.set(chunk, S.buf.length);
  S.buf = merged;
}

function feed(chunk) {
  const now = performance.now();
  S.lastData = now;
  S.bytesWindow.push([now, chunk.length]);
  const cutoff = now - 3000;
  while (S.bytesWindow.length && S.bytesWindow[0][0] < cutoff) S.bytesWindow.shift();

  appendBuf(chunk);

  if (S.mode === 'text') { parseText(); S.dirty = true; return; }

  // Enquanto o modo é '?' o buffer NÃO pode ser consumido como texto: um quadro
  // CRSF chega picado entre leituras, e decodificar destruiria a metade já
  // recebida antes do resto aparecer.
  parseCrsf();
  if (S.mode !== 'crsf') {
    detectMode();
    if (S.mode === 'text') parseText();
  }
  S.dirty = true;
}

function parseCrsf() {
  const b = S.buf;
  let i = 0;
  let consumedAny = false;

  while (i < b.length - 2) {
    if (!ADDRESSES.has(b[i])) { i++; continue; }
    const len = b[i + 1];
    if (len < 2 || len > 62) { i++; continue; }
    if (i + 2 + len > b.length) break;          // quadro incompleto: espera

    // corpo = tipo + payload; o CRC cobre exatamente isso
    const bodyFrom = i + 2, bodyTo = i + 1 + len;
    if (crc8(b, bodyFrom, bodyTo) !== b[bodyTo]) { S.crcErrors++; i++; continue; }

    consumedAny = true;
    consumeFrame(b, bodyFrom, bodyTo);
    i += 2 + len;
  }

  if (consumedAny) {
    if (S.mode === '?') S.mode = 'crsf';
    S.buf = b.subarray(i);
  } else if (b.length > 8192) {
    S.buf = b.subarray(b.length - 256);
  }
}

function consumeFrame(b, from, to) {
  const kind = b[from];
  const payloadLen = to - from - 1;

  if (kind === TYPE_LINK && payloadLen >= 10) {
    const p = from + 1;
    const snr = b[p + 3] < 128 ? b[p + 3] : b[p + 3] - 256;
    S.link = {
      rssi1: b[p], rssi2: b[p + 1], lq: b[p + 2], snr,
      rfMode: b[p + 5], power: b[p + 6],
    };
    S.linkFrames++;
  } else if (kind === TYPE_RC && payloadLen >= 22) {
    S.channels = unpackChannels(b, from + 1);
    S.rcFrames++;
  }
}

/**
 * Decide entre texto e binário pelo conteúdo. Só é chamado depois de o parser
 * CRSF não ter achado quadro nenhum, então a pergunta que resta é: isso é texto
 * legível, ou binário na taxa errada?
 */
function detectMode() {
  if (S.buf.length < 32) return;
  const sample = S.buf.subarray(Math.max(0, S.buf.length - 256));
  let printable = 0;
  for (const x of sample) {
    if ((x >= 0x20 && x < 0x7F) || x === 0x09 || x === 0x0A || x === 0x0D) printable++;
  }
  if (printable / sample.length > 0.85) S.mode = 'text';
}

function parseText() {
  S.textTail += S.decoder.decode(S.buf, { stream: true });
  S.buf = new Uint8Array(0);

  const parts = S.textTail.split('\n');
  S.textTail = parts.pop();
  for (const line of parts) pushLog(line.replace(/\r$/, ''));
}

function pushLog(text, echo = false) {
  S.logLines.push({ text, echo });
  if (S.logLines.length > 500) S.logLines.splice(0, S.logLines.length - 500);
}

// ---------------------------------------------------------------------------
// Serial
// ---------------------------------------------------------------------------

async function connect() {
  try {
    S.port = await navigator.serial.requestPort();
    const baudRate = Number($('baud').value);
    await S.port.open({ baudRate, bufferSize: 8192 });

    try { await S.port.setSignals({ dataTerminalReady: false, requestToSend: false }); }
    catch { /* nem toda ponte USB-serial expõe os sinais */ }

    resetStats();
    S.keepReading = true;
    S.writer = S.port.writable.getWriter();

    const info = S.port.getInfo?.() ?? {};
    $('portName').textContent = info.usbVendorId
      ? `USB ${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`
      : 'conectada';

    $('connect').textContent = 'DESCONECTAR';
    $('connect').classList.remove('btn--go');
    $('reset').disabled = false;
    $('baud').disabled = true;
    hide('oops');

    readLoop();

    // Reinicia por padrão. Sem isso, num receptor ELRS que já subiu o WiFi a
    // porta abre e fica muda pra sempre — e o silêncio parece defeito do app.
    if ($('autoReset').checked) await pulseReset();
  } catch (err) {
    if (err?.name === 'NotFoundError') return;   // usuário fechou o seletor
    fail(err);
  }
}

async function readLoop() {
  while (S.port?.readable && S.keepReading) {
    S.reader = S.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await S.reader.read();
        if (done) break;
        if (value?.length) feed(value);
      }
    } catch (err) {
      if (S.keepReading) fail(err);
    } finally {
      try { S.reader.releaseLock(); } catch { /* já liberado */ }
    }
  }
}

async function disconnect() {
  S.keepReading = false;
  try { await S.reader?.cancel(); } catch { /* já cancelado */ }
  try { S.writer?.releaseLock(); } catch { /* já liberado */ }
  try { await S.port?.close(); } catch { /* já fechada */ }

  S.port = S.reader = S.writer = null;
  $('connect').textContent = 'CONECTAR';
  $('connect').classList.add('btn--go');
  $('reset').disabled = true;
  $('baud').disabled = false;
  $('portName').textContent = '·····';
  S.dirty = true;
}

/** Pulsa DTR/RTS na sequência que põe o ESP32 em reset e o solta. */
async function pulseReset() {
  if (!S.port) return;
  try {
    await S.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, 120));
    await S.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    resetStats();
    pushLog('— reset —', true);
  } catch (err) { fail(err); }
}

async function send(text) {
  if (!S.writer) return;
  await S.writer.write(new TextEncoder().encode(text + '\n'));
  pushLog('> ' + text, true);
  S.dirty = true;
}

function resetStats() {
  S.buf = new Uint8Array(0);
  S.mode = '?';
  S.textTail = '';
  S.lastData = 0;
  S.connectedAt = performance.now();
  S.bytesWindow = [];
  S.rcFrames = S.linkFrames = S.crcErrors = 0;
  S.link = null;
  S.channels = [];
  S.dirty = true;
}

function fail(err) {
  $('oopsTxt').textContent = err?.message ?? String(err);
  $('oops').hidden = false;
}

const hide = (id) => { $(id).hidden = true; };

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function buildChannels() {
  const wrap = $('chans');
  if (wrap.childElementCount) return;
  for (let i = 0; i < 16; i++) {
    const row = document.createElement('div');
    row.className = 'chan';
    row.innerHTML =
      `<span class="chan__lb">CH${i + 1}</span>` +
      '<span class="chan__track"><span class="chan__fill" style="width:50%"></span></span>' +
      '<span class="chan__us">––––</span>';
    wrap.append(row);
  }
}

function rate() {
  if (S.bytesWindow.length < 2) return 0;
  const span = S.bytesWindow.at(-1)[0] - S.bytesWindow[0][0];
  if (span <= 0) return 0;
  return S.bytesWindow.reduce((a, [, n]) => a + n, 0) / (span / 1000);
}

function render() {
  requestAnimationFrame(render);
  if (!S.dirty) return;
  S.dirty = false;

  $('modeTxt').textContent =
    S.mode === 'crsf' ? 'CRSF' : S.mode === 'text' ? 'TEXTO' : S.port ? 'detectando' : '—';

  const showCrsf = S.mode === 'crsf';
  const showText = S.mode === 'text';
  $('viewCrsf').hidden = !showCrsf;
  $('viewText').hidden = !showText;
  $('viewIdle').hidden = showCrsf || showText;

  if (showCrsf) renderCrsf();
  if (showText) renderText();
  renderTally();
  renderIdle();
}

function renderCrsf() {
  buildChannels();
  const L = S.link;

  if (L) {
    const state = L.lq === 0 ? 'off' : L.lq >= 70 ? 'good' : 'weak';
    document.body.dataset.link = state;
    $('link').dataset.state = L.lq === 0 ? 'off' : L.lq >= 70 ? 'on' : 'warn';
    $('linkTxt').textContent = L.lq === 0 ? 'SEM ENLACE' : 'CONECTADO';

    $('lq').textContent = L.lq;
    $('lqBar').style.width = L.lq + '%';
    $('rssi').textContent = L.rssi1 ? '-' + L.rssi1 : '–––';
    $('snr').textContent = (L.snr > 0 ? '+' : '') + L.snr;
    $('pwr').textContent = TX_POWER_MW[L.power] ?? L.power;
    $('rfmode').textContent = L.rfMode;
  }

  const rows = $('chans').children;
  for (let i = 0; i < 16; i++) {
    const raw = S.channels[i];
    const fill = rows[i].querySelector('.chan__fill');
    const us = rows[i].querySelector('.chan__us');
    if (raw === undefined) { fill.style.width = '50%'; us.textContent = '––––'; continue; }
    fill.style.width = Math.max(0, Math.min(100, ((raw - 172) / (1811 - 172)) * 100)) + '%';
    us.textContent = toMicroseconds(raw);
  }
}

function renderText() {
  const el = $('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = S.logLines
    .map((l) => (l.echo ? `<b>${escapeHtml(l.text)}</b>` : escapeHtml(l.text)))
    .join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;   // só segue se já estava no fim
}

function renderIdle() {
  if (!S.port) {
    $('idleTxt').textContent = 'Conecte a placa para começar.';
    return;
  }

  // Silêncio é o estado ambíguo desta placa, então ele precisa se explicar em
  // vez de deixar a tela vazia: nada aqui é distinguível de "app quebrado".
  const since = (performance.now() - (S.lastData || S.connectedAt)) / 1000;
  if (!S.lastData) {
    $('idleTxt').textContent = since < 6
      ? 'Conectada. Aguardando os primeiros bytes…'
      : `Conectada há ${since.toFixed(0)} s e nenhum byte chegou. Tente RESET.`;
  } else {
    $('idleTxt').textContent = `Recebeu dados, mas parou há ${since.toFixed(0)} s.`;
  }
}

function renderTally() {
  $('cRc').textContent = S.rcFrames;
  $('cLink').textContent = S.linkFrames;
  $('cCrc').textContent = S.crcErrors;
  $('cRate').textContent = rate().toFixed(0);

  if (!S.port) { $('cIdle').textContent = '—'; return; }
  const quiet = S.lastData ? (performance.now() - S.lastData) / 1000 : null;
  $('cIdle').textContent = quiet === null ? 'aguardando' :
    quiet < 1.5 ? 'ativa' : `parada ha ${quiet.toFixed(0)}s`;
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------------------------------------------------------------------------
// Ligação
// ---------------------------------------------------------------------------

if (!('serial' in navigator)) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}

$('connect').addEventListener('click', () => (S.port ? disconnect() : connect()));
$('reset').addEventListener('click', pulseReset);
$('clear').addEventListener('click', () => { S.logLines = []; resetStats(); });

$('promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('promptInput');
  const text = input.value.trim();
  if (!text) return;
  send(text);
  input.value = '';
});

navigator.serial?.addEventListener('disconnect', () => { if (S.port) disconnect(); });

// o relógio precisa correr mesmo sem bytes: é assim que o silêncio aparece
setInterval(() => { if (S.port) S.dirty = true; }, 500);

render();
