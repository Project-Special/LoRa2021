/* =============================================================================
   LoRa2021 — painel de bancada
   Estado lido em polling de 1 s; o registro vem junto, com id incremental, pra
   não precisar de WebSocket (num ESP32 com o rádio em ISR só traria disputa
   por CPU sem ganho real aqui).
   ========================================================================== */

'use strict';

const $ = (id) => document.getElementById(id);

// Valores aceitos pelo LR2021 — constantes do chip, não do firmware.
const SF = [5, 6, 7, 8, 9, 10, 11, 12];
const CR = [4, 5, 6, 7, 8];
const BW = [31.25, 41.67, 62.5, 83.33, 100, 125, 203.125, 250, 406.25, 500, 812.5, 1000];

// Posições da matriz de solda do módulo — servem de portadora e de rede casada.
const POS = [150, 433, 470, 868, 915];

// Espelho de kBandProfiles (lib/LoraLink/radio_profile.h). Existe pra a página
// nascer montada mesmo sem rádio respondendo: /api/state sobrescreve quando
// chega. Sem isto, abrir o arquivo direto (ou por Live Server, sem a API) dava
// um painel completamente vazio.
const BANDS = [
  { id: '150',   name: '150 MHz',        note: 'Posição mais baixa da matriz do módulo — uso licenciado' },
  { id: '433',   name: '433 MHz ISM',    note: 'ISM região 1 / radioamador — conferir ciclo de trabalho local' },
  { id: '470',   name: '470 MHz',        note: 'Plano de banda CN470' },
  { id: '868',   name: '868 MHz EU',     note: 'EU868 — limite de +14 dBm ERP, 1% de ciclo de trabalho' },
  { id: '915',   name: '915 MHz AU/US',  note: 'AU915 / US915 — é o plano usado no Brasil' },
  { id: 'sband', name: 'S-band 2.1 GHz', note: 'Banda de satélite LICENCIADA — só laboratório / teste' },
  { id: '2g4',   name: '2.4 GHz ISM',    note: 'ISM mundial — banda larga, vazão bem maior' },
];

const DBM_LO = -130;
const DBM_HI = -30;
const HIST = 90;                 // amostras no gráfico (1 s cada)

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const frac = (dbm) => clamp01((dbm - DBM_LO) / (DBM_HI - DBM_LO));

let lastLog = -1;
let booted = false;
const dirty = new Set();
const history = [];

/* ────────────────────────────────────────────────────────────── ponteiro ── */

const CXP = 120, CYP = 124, R = 88;      // centro e raio do arco
const ARC_LEN = Math.PI * R;

(function buildTicks() {
  let out = '';
  for (let dbm = DBM_LO; dbm <= DBM_HI; dbm += 20) {
    const th = Math.PI * (1 - frac(dbm));          // 180°..0°
    const cos = Math.cos(th), sin = Math.sin(th);
    const at = (r) => [CXP + r * cos, CYP - r * sin];
    // traços e rótulos ficam POR FORA do arco: por dentro eles se amontoavam
    // no miolo e brigavam com o ponteiro.
    const [x1, y1] = at(R + 5);
    const [x2, y2] = at(R + 12);
    const [tx, ty] = at(R + 24);
    // nas pontas o rótulo é ancorado pela lateral, senão o "-130" fica
    // centrado na linha do pivô e parece que escorregou pra fora da escala
    const anchor = cos < -0.7 ? 'end' : cos > 0.7 ? 'start' : 'middle';
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    out += `<text text-anchor="${anchor}" x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}">${dbm}</text>`;
  }
  $('ticks').innerHTML = out;
})();

function setMeter(dbm) {
  const f = frac(dbm);
  $('needle').style.transform = `rotate(${(-90 + f * 180).toFixed(1)}deg)`;
  $('arc').style.strokeDashoffset = (ARC_LEN * (1 - f)).toFixed(1);
}

/* ─────────────────────────────────────────────────────────────── gráfico ── */

const cv = $('chart');
const cx = cv.getContext('2d');

// Janela vertical do gráfico. Fica em degraus de 20/40/80 dB e só se remexe
// quando o dado sai dela ou fica pequeno demais dentro dela — sem isso o eixo
// se redesenhava a cada segundo e a curva tremia na vertical.
const yScale = { lo: -110, hi: -70 };

function updateScale() {
  if (!history.length) return;
  const mn = Math.min(...history), mx = Math.max(...history);
  const span = yScale.hi - yScale.lo;
  const dentro = mn > yScale.lo + 2 && mx < yScale.hi - 2;
  const frouxa = (mx - mn) < span * 0.3 && span > 10;
  if (dentro && !frouxa) return;

  // começa em 10 dB: parando em 20 o enlace estável (que varia ~5 dB) ocupava
  // um quarto da altura e o espaço dado ao gráfico virava grade vazia
  let novo = 10;
  while (novo < (mx - mn) * 1.8 && novo < 80) novo *= 2;
  // encaixa o piso num múltiplo do passo da grade (linhas em números redondos)
  // sem arredondar o centro antes, senão a curva fica encostada num dos lados
  const st = novo >= 80 ? 20 : novo >= 40 ? 10 : novo >= 20 ? 5 : 2;
  const mid = (mn + mx) / 2;
  yScale.lo = Math.max(-140, Math.floor((mid - novo / 2) / st) * st);
  yScale.hi = Math.min(-20, yScale.lo + novo);
}

const PAD = { r: 12, t: 14, b: 18 };

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);

  const glow = getComputedStyle(document.documentElement)
    .getPropertyValue('--glow').trim() || '#6cf0a0';

  const padL = w < 460 ? 26 : 38;
  const x0 = padL, x1 = w - PAD.r;
  const y0 = PAD.t, y1 = h - PAD.b;
  const plotW = x1 - x0, plotH = y1 - y0;

  updateScale();
  const { lo, hi } = yScale;
  const step = hi - lo >= 80 ? 20 : hi - lo >= 40 ? 10 : hi - lo >= 20 ? 5 : 2;
  const yAt = (v) => y1 - plotH * clamp01((v - lo) / (hi - lo));

  // ---- grade + escala em dBm ------------------------------------------
  cx.font = '700 10px ' + getComputedStyle(cv).fontFamily;
  cx.textBaseline = 'middle';
  for (let dbm = Math.ceil(lo / step) * step; dbm <= hi; dbm += step) {
    const y = Math.round(yAt(dbm)) + 0.5;
    cx.strokeStyle = '#1a2320';
    cx.setLineDash([2, 4]);
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(x0, y); cx.lineTo(x1, y); cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = '#8a9a93';
    cx.textAlign = 'right';
    cx.fillText(String(dbm), x0 - 7, y);
  }
  // divisões de tempo, uma a cada 15 s
  for (let i = 0; i <= 6; i++) {
    const x = Math.round(x0 + (plotW * i) / 6) + 0.5;
    if (i > 0 && i < 6) {
      cx.strokeStyle = '#161e1b';
      cx.beginPath(); cx.moveTo(x, y0); cx.lineTo(x, y1); cx.stroke();
    }
    // estreito: um rótulo sim, outro não — senão "-15s" e "agora" se encostam
    if (w < 460 && i % 2 && i !== 6) continue;
    cx.fillStyle = '#7a8a84';
    // nas pontas alinha pela lateral: no centro o primeiro invadia a calha
    // dos dBm e o último passava da borda
    cx.textAlign = i === 0 ? 'left' : i === 6 ? 'right' : 'center';
    cx.fillText(i === 6 ? 'agora' : `-${(6 - i) * 15}s`, x, y1 + 9);
  }

  // moldura do gráfico
  cx.strokeStyle = '#1d2622';
  cx.strokeRect(x0 + 0.5, y0 + 0.5, plotW - 1, plotH - 1);

  if (history.length < 2) return;

  // Enquanto a janela não encheu, os pontos se espalham por toda a largura —
  // o gráfico já nasce legível em vez de um traço espremido na direita.
  const n = history.length;
  const xAt = (i) => x0 + (plotW * i) / (n - 1);

  const pts = history.map((v, i) => [xAt(i), yAt(v)]);

  // traça a curva suavizada (pontos médios + quadráticas)
  const path = () => {
    cx.beginPath();
    cx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i];
      cx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    }
    cx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };

  // área
  const grad = cx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, glow + '4d');
  grad.addColorStop(1, glow + '00');
  cx.save();
  path();
  cx.lineTo(pts[pts.length - 1][0], y1);
  cx.lineTo(pts[0][0], y1);
  cx.closePath();
  cx.fillStyle = grad;
  cx.fill();
  cx.restore();

  // linha
  path();
  cx.strokeStyle = glow;
  cx.lineWidth = 1.6;
  cx.lineJoin = 'round';
  cx.lineCap = 'round';
  cx.shadowColor = glow + '99';
  cx.shadowBlur = 6;
  cx.stroke();
  cx.shadowBlur = 0;

  // nível atual: tracejada neutra até a borda. No acento ela virava uma
  // segunda curva luminosa competindo com o dado.
  const [lx, ly] = pts[pts.length - 1];
  cx.strokeStyle = '#ffffff1a';
  cx.setLineDash([3, 3]);
  cx.beginPath(); cx.moveTo(x0, ly); cx.lineTo(lx, ly); cx.stroke();
  cx.setLineDash([]);

  cx.fillStyle = glow;
  cx.shadowColor = glow;
  cx.shadowBlur = 10;
  cx.beginPath(); cx.arc(lx, ly, 3, 0, Math.PI * 2); cx.fill();
  cx.shadowBlur = 0;
}

window.addEventListener('resize', drawChart);

/* ─────────────────────────────────────────────────────────────── registro ── */

let logSeq = 0;

function log(kind, msg) {
  const li = document.createElement('li');
  li.className = kind;
  if (logSeq++ % 2) li.classList.add('alt');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  li.innerHTML = `<time>${hh}:${mm}:${ss}</time><span class="msg"></span>`;
  li.querySelector('.msg').textContent = msg;

  const box = $('log');
  box.prepend(li);
  while (box.children.length > 120) box.lastElementChild.remove();
}

$('clear').addEventListener('click', () => { $('log').innerHTML = ''; });

/* ───────────────────────────────────────────────────────────────── rede ── */

async function api(path, body) {
  const opt = body
    ? { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body) }
    : {};
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/* ─────────────────────────────────────────────────────────────── widgets ── */

function fillSelect(el, values) {
  el.innerHTML = values.map((v) => `<option value="${v}">${v}</option>`).join('');
}

function buildBands() {
  const box = $('bands');
  box.innerHTML = BANDS
    .map((b) => `<button type="button" data-id="${b.id}" aria-pressed="false">${b.id.toUpperCase()}</button>`)
    .join('');

  box.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const b = BANDS.find((x) => x.id === btn.dataset.id);
    try {
      const st = await api('api/config', { band: btn.dataset.id });
      dirty.clear();
      history.length = 0;              // outra banda, outra escala de sinal
      render(st, true);
      log('sys', `banda: ${b.name}`);
    } catch (e) {
      log('err', `falha ao trocar de banda: ${e.message}`);
    }
  });
}

// Par de teste: o usuário declara o que está do outro lado e o rádio se
// configura naquela modulação. É <select> e não botões pelo mesmo motivo da
// rede de casamento — não competir com a grade de bandas.
const PEERS = [
  { id: 'bancada', name: 'Outra placa LoRa2021', decodes: true,
    note: 'Par igual a este firmware: decodifica e faz ping-pong.' },
  { id: 'elrs2g4', name: 'Transmissor ExpressLRS 2.4 GHz', decodes: false,
    note: 'Escuta na modulação do ELRS 2.4 GHz 50 Hz.' },
  { id: 'elrs900', name: 'Transmissor ExpressLRS 900 MHz', decodes: false,
    note: 'Escuta na modulação do ELRS 900 MHz 50 Hz.' },
];

function buildPeers(list) {
  const el = $('peer');
  el.innerHTML = list.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  el.addEventListener('change', async (ev) => {
    try {
      const st = await api('api/config', { peer: ev.target.value });
      dirty.clear();
      history.length = 0;
      render(st, true);
    } catch (e) {
      log('err', `par de teste: ${e.message}`);
    }
  });
}

function buildMatch() {
  const el = $('match');
  el.innerHTML = POS.map((m) => `<option value="${m}">${m} MHz</option>`).join('');
  el.addEventListener('change', async (ev) => {
    try {
      render(await api('api/config', { match: ev.target.value }), true);
      log('sys', `rede de casamento: ${ev.target.value} MHz`);
    } catch (e) {
      log('err', `rede de casamento: ${e.message}`);
    }
  });
}

/** Escreve só se o usuário não estiver mexendo no campo. */
function put(el, value) {
  if (dirty.has(el.id) || document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

/** Atualiza um contador e pisca se mudou. */
function readout(el, value) {
  const txt = String(value);
  if (el.textContent === txt) return;
  el.textContent = txt;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ────────────────────────────────────────────────────────────────  render ── */

function render(s, force = false) {
  document.documentElement.dataset.band = s.band;

  $('node').textContent = s.node;

  const link = $('link');
  link.dataset.state = s.linked ? 'on' : 'off';
  $('linkTxt').textContent = s.linked ? 'ATIVO' : 'AUSENTE';

  if (s.rx > 0) {
    $('rssi').textContent = s.rssi.toFixed(1);
    $('snr').textContent = s.snr.toFixed(1);
    setMeter(s.rssi);
    history.push(s.rssi);
    while (history.length > HIST) history.shift();
    drawChart();
  }

  $('toa').textContent = s.toa;
  readout($('tx'), s.tx);
  readout($('rx'), s.rx);
  readout($('err'), s.err);
  // vermelho só quando o erro é relevante — antes acendia em 1 pacote ruim e
  // virava o segundo elemento mais gritante da página
  $('err').classList.toggle('hot', s.err > 3 && s.err > (s.rx + s.err) * 0.05);
  // sem medida, esconde a unidade: "— ms" parecia campo quebrado
  readout($('rtt'), s.rtt > 0 ? s.rtt : '—');
  $('rtt').parentElement.classList.toggle('no-unit', !(s.rtt > 0));

  for (const b of $('bands').children) {
    b.setAttribute('aria-pressed', String(b.dataset.id === s.band));
  }
  const cur = (s.bands || BANDS).find((b) => b.id === s.band);
  if (cur) {
    $('bandNote').textContent = cur.note;
    $('bandName').textContent = cur.name;
  }
  $('pathNote').textContent = s.hf ? 'HF · 2.4G / S-band' : 'LF · sub-GHz';
  $('paCeil').textContent = `${s.pmax} dBm`;

  put($('match'), s.match);

  const peers = s.peerOpts || PEERS;
  put($('peer'), s.peer || 'bancada');
  const pp = peers.find((x) => x.id === (s.peer || 'bancada'));
  if (pp) $('peerNote').textContent = pp.note;
  $('peerWarn').hidden = s.peerDecodes !== false;

  // A frase é um campo que o usuário digita: sobrescrevê-la a cada poll apagaria
  // o que ele está escrevendo. Só atualiza quando o campo não está sujo — mesma
  // regra dos outros campos editáveis.
  if (s.phrase !== undefined && !dirty.has('phrase')) $('phrase').value = s.phrase;
  if (s.uid !== undefined) {
    $('uid').textContent = s.uid;
    // Bit 0 do último byte do UID, igual ao ExpressLRS decide.
    const last = parseInt(s.uid.trim().split(/\s+/).pop(), 16);
    $('iq').textContent = Number.isNaN(last) ? '·' : (last & 1 ? 'invertido' : 'normal');
  }
  $('matchWarn').hidden = !s.mismatch;

  // radioOk pode faltar em firmware antigo: só esconde quando é explicitamente
  // false, pra não piscar um alarme falso
  const radioDown = s.radioOk === false;
  $('radioWarn').hidden = !radioDown;
  if (radioDown) $('radioErr').textContent = s.radioErr || 'motivo desconhecido';

  put($('freq'), s.freq.toFixed(3));
  put($('power'), s.power);
  put($('sf'), s.sf);
  put($('cr'), s.cr);
  put($('bw'), s.bw);
  put($('beacon'), s.beacon);
  put($('interval'), s.interval);

  $('powerHint').textContent = `faixa permitida ${s.pmin} a ${s.pmax} dBm nesta banda`;

  if (Array.isArray(s.log)) {
    for (const e of s.log) {
      if (e.i > lastLog) { log(e.k, e.t); lastLog = e.i; }
    }
  }

  booted = true;
}

/* ────────────────────────────────────────────────────────────────── ações ── */

for (const id of ['freq', 'power', 'sf', 'cr', 'bw', 'interval', 'msg', 'phrase']) {
  $(id).addEventListener('input', () => dirty.add(id));
}

$('apply').addEventListener('click', async () => {
  try {
    const st = await api('api/config', {
      freq: $('freq').value,
      power: $('power').value,
      sf: $('sf').value,
      cr: $('cr').value,
      bw: $('bw').value,
    });
    dirty.clear();
    render(st, true);
    log('sys', `${st.freq.toFixed(3)} MHz · SF${st.sf} · BW ${st.bw} kHz · CR 4/${st.cr} · ${st.power} dBm`);
  } catch (e) {
    log('err', `aplicar falhou: ${e.message}`);
  }
});

$('phraseSave').addEventListener('click', async () => {
  const phrase = $('phrase').value.trim();
  if (!phrase) { log('err', 'frase vazia'); return; }
  try {
    const st = await api('api/config', { phrase });
    dirty.delete('phrase');
    render(st, true);
    log('sys', `binding "${phrase}" · UID ${st.uid || '?'}`);
  } catch (e) {
    log('err', `frase recusada: ${e.message}`);
  }
});

$('send').addEventListener('click', async () => {
  const text = $('msg').value.trim() || 'hello';
  try { await api('api/send', { text }); }
  catch (e) { log('err', `envio falhou: ${e.message}`); }
});

$('ping').addEventListener('click', async () => {
  try { await api('api/ping', {}); }
  catch (e) { log('err', `ping falhou: ${e.message}`); }
});

$('beacon').addEventListener('change', async (ev) => {
  try {
    await api('api/config', { beacon: ev.target.checked ? '1' : '0' });
    log('sys', `beacon ${ev.target.checked ? 'ligado' : 'desligado'}`);
  } catch (e) {
    log('err', `beacon falhou: ${e.message}`);
  }
});

$('interval').addEventListener('change', async (ev) => {
  try {
    await api('api/config', { interval: ev.target.value });
    dirty.delete('interval');
    log('sys', `intervalo do beacon: ${ev.target.value} ms`);
  } catch (e) {
    log('err', `intervalo falhou: ${e.message}`);
  }
});

/* ─────────────────────────────────────────────────────────────────── loop ── */

let offline = false;

async function poll() {
  try {
    render(await api('api/state'));
    if (offline) { offline = false; log('sys', 'rádio respondendo de novo'); }
  } catch (e) {
    if (!offline) { offline = true; log('err', 'sem resposta do rádio'); }
  }
}

/* Tudo que é constante é montado ANTES de falar com o rádio: assim a página
   abre legível mesmo sem API (arquivo direto, Live Server, rádio fora do ar) e
   o polling só preenche valores. */
buildBands();
buildMatch();
buildPeers(PEERS);
fillSelect($('sf'), SF);
fillSelect($('cr'), CR);
fillSelect($('bw'), BW);

drawChart();
poll();
setInterval(poll, 1000);

/* =============================================================================
   Aba "Banco de dados"

   Le o Supabase direto do navegador, por REST — sem biblioteca. O painel nao
   tem etapa de build (mora no LittleFS da placa), entao qualquer dependencia
   teria de ser um <script> de CDN que a placa nunca conseguiria servir.

   So funciona com o painel aberto NO PC. Pelo AP da placa nao ha internet, e a
   aba diz isso em vez de ficar girando.
   ========================================================================== */

const DB = {
  list: [],
  session: null,
  map: null,
  layer: null,
  leaflet: false,
};

const cfgOk = () => !!(window.SUPABASE && window.SUPABASE.url && window.SUPABASE.key);

/** GET no PostgREST. Erro vira excecao, e a aba mostra o motivo na nota. */
async function sb(path) {
  const r = await fetch(`${window.SUPABASE.url}/rest/v1/${path}`, {
    headers: {
      apikey: window.SUPABASE.key,
      Authorization: `Bearer ${window.SUPABASE.key}`,
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const fmtDist = (m) =>
  m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`;

/* Mesma escala de cor do app: -40 dBm colado, -120 no limite da sensibilidade.
   Repetida aqui de proposito — o painel nao compartilha codigo com o app, e um
   import forcaria uma etapa de build que este arquivo nao tem. */
function rssiColor(v) {
  if (v == null) return '#64748b';
  const k = (Math.max(-120, Math.min(-40, v)) + 120) / 80;
  return `hsl(${Math.round(k * 120)}, 85%, 45%)`;
}

const TRAIL_OK = '#34C759';
const TRAIL_DOWN = '#FF3B30';

/** Carrega o Leaflet so quando a aba abre: na placa ele nunca seria baixado. */
function loadLeaflet() {
  if (DB.leaflet) return Promise.resolve(true);
  return new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => { DB.leaflet = true; resolve(true); };
    js.onerror = () => resolve(false);
    document.head.appendChild(js);
  });
}

function dbNote(text) { $('dbNote').textContent = text; }

async function dbLoadList() {
  if (!cfgOk()) {
    // O formulario ja esta na tela; a nota so diz por que a lista esta vazia.
    dbNote('Informe o projeto Supabase acima para ver as campanhas.');
    return;
  }
  dbNote('Lendo o banco…');
  try {
    DB.list = await sb(
      'range_session_summary?select=id,local_id,name,created_at,band,samples,' +
      'max_distance_m,best_rssi_dbm,worst_rssi_dbm&order=created_at.desc',
    );
    renderDbList();
    dbNote(DB.list.length ? `${DB.list.length} campanha(s) no banco.` : 'Nenhuma campanha no banco.');
  } catch (e) {
    dbNote(`Falha ao ler: ${e.message}`);
  }
}

function renderDbList() {
  const box = $('dbList');
  box.innerHTML = '';
  for (const r of DB.list) {
    const li = document.createElement('li');
    li.className = 'db__item';
    li.dataset.id = r.id;
    if (!r.samples) li.dataset.empty = '1';

    // textContent, e nao innerHTML: o nome da campanha e digitado pelo usuario
    // no celular e chega aqui sem passar por validacao nenhuma.
    const b = document.createElement('b');
    b.textContent = r.name || 'sem nome';
    const d = document.createElement('span');
    d.textContent = `${new Date(r.created_at).toLocaleString('pt-BR')} · ${r.band || '—'}`;
    const p = document.createElement('span');
    p.textContent = `${r.samples} pontos · ${fmtDist(r.max_distance_m)}`;

    const del = document.createElement('button');
    del.className = 'db__del';
    del.type = 'button';
    del.textContent = 'apagar da nuvem';
    // stopPropagation: o item inteiro abre a campanha ao ser clicado, e sem
    // isto apagar abriria o que se acabou de apagar.
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void dbDelete(r);
    });

    li.append(b, d, p, del);

    if (r.samples) li.addEventListener('click', () => dbOpen(r));
    box.appendChild(li);
  }
}

/**
 * Apaga a campanha do banco.
 *
 * A confirmacao NOMEIA a campanha e diz quantos pontos vao junto. Um "tem
 * certeza?" generico e ruido que se aprende a clicar sem ler, e aqui nao ha
 * desfazer: a nuvem costuma ser a ultima copia de uma campanha ja apagada do
 * celular.
 */
async function dbDelete(item) {
  const msg =
    `Apagar "${item.name}" do banco?` +
    String.fromCharCode(10, 10) +
    `${item.samples} pontos serao removidos junto. Nao ha como desfazer.`;
  if (!window.confirm(msg)) return;

  dbNote(`Apagando "${item.name}"…`);
  try {
    // return=representation faz o PostgREST devolver o que apagou. Sem isso,
    // e sem a politica de DELETE no banco, a resposta seria 200 com zero linhas
    // e o painel diria "apagado" sem ter apagado nada.
    const r = await fetch(
      `${window.SUPABASE.url}/rest/v1/range_sessions?id=eq.${item.id}`,
      {
        method: 'DELETE',
        headers: {
          apikey: window.SUPABASE.key,
          Authorization: `Bearer ${window.SUPABASE.key}`,
          Prefer: 'return=representation',
        },
      },
    );
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const gone = await r.json();
    if (!gone.length) {
      const msg =
        'NADA FOI APAGADO.' +
        String.fromCharCode(10, 10) +
        'O banco recusa DELETE: falta a politica de RLS. Rode ' +
        'alcance_lora/migration-delete.sql no SQL Editor do Supabase.';
      // alert, e nao so a nota do topo: o botao fica no fim de uma lista longa,
      // e uma mensagem a 600 px de distancia do clique nao e lida. Acao
      // destrutiva que falhou tem de interromper.
      window.alert(msg);
      dbNote('Nada foi apagado — o banco nao permite DELETE (ver migration-delete.sql).');
      return;
    }

    DB.list = DB.list.filter((x) => x.id !== item.id);
    renderDbList();
    if (DB.session && DB.session.item.id === item.id) {
      DB.session = null;
      $('dbStats').hidden = true;
      $('dbRows').innerHTML = '';
      if (DB.layer) DB.layer.clearLayers();
    }
    dbNote(`"${item.name}" apagada. ${DB.list.length} campanha(s) restantes.`);
  } catch (e) {
    dbNote(`Falha ao apagar: ${e.message}`);
  }
}

async function dbOpen(item) {
  for (const el of $('dbList').children) {
    el.setAttribute('aria-current', String(el.dataset.id === item.id));
  }
  dbNote(`Baixando "${item.name}" — ${item.samples} pontos…`);

  try {
    // Paginado: o PostgREST corta em 1000 linhas sem avisar, e um trajeto
    // truncado ainda parece um trajeto — ninguem desconfiaria.
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = await sb(
        'range_samples?select=t,latitude,longitude,altitude,accuracy_m,distance_m,' +
        `rssi_dbm,snr_db,lq,linked&session_id=eq.${item.id}&order=t.asc&offset=${from}&limit=1000`,
      );
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const head = await sb(`range_sessions?select=origin_lat,origin_lon&id=eq.${item.id}`);
    DB.session = { item, rows, origin: head[0] || null };

    renderDbStats();
    renderDbRows();
    await renderDbMap();
    dbNote(`"${item.name}" — ${rows.length} pontos.`);
  } catch (e) {
    dbNote(`Falha ao baixar: ${e.message}`);
  }
}

function renderDbStats() {
  const rows = DB.session.rows;
  const linked = rows.filter((r) => r.linked && r.distance_m != null);
  const rssi = rows.map((r) => r.rssi_dbm).filter((v) => v != null);
  const lost = rows.filter((r) => !r.linked).length;
  const noRssi = rows.length - rssi.length;

  $('dbStats').hidden = false;
  $('dbPts').textContent = rows.length;
  // O alcance que interessa e o ponto mais longe COM enlace. O mais longe da
  // trilha pode ser onde o sinal ja tinha caido e o operador seguiu andando.
  $('dbReach').textContent = fmtDist(
    linked.length ? Math.max(...linked.map((r) => r.distance_m)) : null,
  );
  $('dbLost').textContent = lost;
  $('dbLost').className = lost ? 'bad' : '';
  $('dbBest').textContent = rssi.length ? Math.max(...rssi) : '—';
  $('dbWorst').textContent = rssi.length ? Math.min(...rssi) : '—';
  // Ponto sem RSSI chegou com a telemetria quebrada. Sem este numero, melhor e
  // pior seriam lidos como se cobrissem todos os pontos.
  $('dbNoRssi').textContent = noRssi;
  $('dbNoRssi').className = noRssi ? 'warn' : '';
}

function renderDbRows() {
  const tb = $('dbRows');
  tb.innerHTML = '';
  for (const r of DB.session.rows) {
    const tr = document.createElement('tr');

    const plain = [
      new Date(r.t).toLocaleTimeString('pt-BR'),
      Number(r.latitude).toFixed(6),
      Number(r.longitude).toFixed(6),
      r.altitude == null ? '—' : Math.round(r.altitude),
      r.accuracy_m == null ? '—' : Math.round(r.accuracy_m),
      fmtDist(r.distance_m),
    ];
    for (const c of plain) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const rs = document.createElement('td');
    rs.textContent = r.rssi_dbm == null ? '—' : r.rssi_dbm;
    rs.style.color = rssiColor(r.rssi_dbm);
    tr.appendChild(rs);

    for (const c of [r.snr_db == null ? '—' : r.snr_db, r.lq == null ? '—' : r.lq]) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const lk = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'db__dot';
    dot.style.background = r.linked ? TRAIL_OK : TRAIL_DOWN;
    lk.appendChild(dot);
    tr.appendChild(lk);

    tb.appendChild(tr);
  }
}

async function renderDbMap() {
  const ok = await loadLeaflet();
  if (!ok) {
    $('dbMap').textContent = 'Mapa indisponivel — sem internet para carregar o Leaflet.';
    return;
  }

  if (!DB.map) {
    DB.map = L.map($('dbMap'), { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(DB.map);
    DB.layer = L.layerGroup().addTo(DB.map);
  }
  DB.layer.clearLayers();
  DB.map.invalidateSize();

  const rows = DB.session.rows;
  if (!rows.length) return;

  const o = DB.session.origin;
  const hasOrigin = o && o.origin_lat != null && o.origin_lon != null;
  if (hasOrigin) {
    L.circleMarker([o.origin_lat, o.origin_lon], {
      radius: 9, color: '#ffffff', weight: 2, fillColor: '#137fec', fillOpacity: 1,
    }).bindPopup('<b>Transmissor</b>').addTo(DB.layer);

    // Aneis de referencia: dao escala ao mapa sem precisar medir nada.
    for (const rad of [250, 500, 1000, 2000]) {
      L.circle([o.origin_lat, o.origin_lon], {
        radius: rad, color: '#137fec', weight: 1, opacity: .35, fill: false, dashArray: '4 6',
      }).addTo(DB.layer);
    }
  }

  // Rastro em trechos, verde onde havia enlace e vermelho tracejado onde nao —
  // a mesma leitura do app. Trechos de mesma cor viram uma polilinha so, senao
  // uma campanha longa criaria centenas de camadas e o mapa engasgaria.
  let run = [];
  let runOk = null;
  const flush = () => {
    if (run.length > 1 && runOk !== null) {
      L.polyline(run, {
        color: runOk ? TRAIL_OK : TRAIL_DOWN,
        weight: 4,
        opacity: .85,
        dashArray: runOk ? undefined : '6 6',
      }).addTo(DB.layer);
    }
  };
  for (let i = 1; i < rows.length; i++) {
    // O trecho so e verde se havia enlace nas DUAS pontas: meio caminho sem
    // link nao e meio verde, e perda.
    const segOk = rows[i - 1].linked && rows[i].linked;
    if (segOk !== runOk) {
      flush();
      run = [[rows[i - 1].latitude, rows[i - 1].longitude]];
      runOk = segOk;
    }
    run.push([rows[i].latitude, rows[i].longitude]);
  }
  flush();

  for (const r of rows) {
    L.circleMarker([r.latitude, r.longitude], {
      radius: 5,
      color: r.linked ? TRAIL_OK : TRAIL_DOWN,
      weight: 2,
      fillColor: rssiColor(r.rssi_dbm),
      fillOpacity: .9,
    })
      .bindPopup(
        `<b>${r.rssi_dbm == null ? '—' : r.rssi_dbm} dBm</b><br>` +
        `SNR ${r.snr_db == null ? '—' : r.snr_db} dB<br>` +
        `dist ${fmtDist(r.distance_m)}<br>` +
        `${new Date(r.t).toLocaleTimeString('pt-BR')}` +
        (r.linked ? '' : '<br><b style="color:#FF3B30">sem enlace</b>'),
      )
      .addTo(DB.layer);
  }

  const pts = rows.map((r) => [r.latitude, r.longitude]);
  if (hasOrigin) pts.push([o.origin_lat, o.origin_lon]);
  DB.map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

/* --- troca de aba ---------------------------------------------------------
   O polling do radio continua rodando nas duas: sair da aba nao e sair da
   bancada, e o registro tem de estar completo quando se voltar. */
function showTab(which) {
  const db = which === 'db';
  // Sair da aba com o mapa expandido deixaria um mapa fixed cobrindo a
  // bancada, sem nada visível para fechá-lo.
  if (!db && typeof mapIsFull === 'function' && mapIsFull()) setMapFull(false);
  $('tabBench').setAttribute('aria-selected', String(!db));
  $('tabDb').setAttribute('aria-selected', String(db));
  $('viewBench').hidden = db;
  $('viewDb').hidden = !db;

  if (db) {
    // Pede a credencial ASSIM QUE A ABA ABRE, e não quando alguma consulta
    // falha: descobrir que falta configuração depois de clicar em algo é o
    // caminho mais longo para a mesma informação.
    if (!cfgOk()) dbNote('Informe o projeto Supabase para ver as campanhas.');
    else if (!DB.list.length) void dbLoadList();
  }
  // O Leaflet mede o container na criacao; criado escondido, mede zero e o mapa
  // fica cinza pela metade. Remedir ao mostrar a aba e obrigatorio.
  if (db && DB.map) setTimeout(() => DB.map.invalidateSize(), 60);
}

$('tabBench').addEventListener('click', () => showTab('bench'));
$('tabDb').addEventListener('click', () => showTab('db'));
$('dbReload').addEventListener('click', () => { DB.list = []; void dbLoadList(); });

/* --- mapa em tela cheia ----------------------------------------------------
   O mapa útil de uma campanha é o grande: numa caixa de 300 px, um trajeto de
   quilômetros vira um risco. Aqui o invólucro passa a `fixed` cobrindo a
   página, e o mesmo elemento do Leaflet continua no lugar — nada é recriado,
   então o enquadramento e os tiles já carregados sobrevivem à troca. */
function setMapFull(on) {
  const wrap = $('dbMapWrap');
  wrap.classList.toggle('db__mapwrap--full', on);
  $('dbFull').textContent = on ? '← voltar' : '⤢ tela cheia';

  // Trava a rolagem do fundo: sem isso o gesto de arrastar o mapa rolava a
  // página junto, e o mapa "escapava" enquanto se tentava mover nele.
  document.body.style.overflow = on ? 'hidden' : '';

  // invalidateSize é obrigatório: o Leaflet mede o container quando ele muda de
  // tamanho, não sozinho. Sem isto metade do mapa fica cinza, com tiles só na
  // faixa do tamanho antigo.
  if (DB.map) {
    DB.map.invalidateSize();
    setTimeout(() => DB.map.invalidateSize(), 80);
  }
}

const mapIsFull = () => $('dbMapWrap').classList.contains('db__mapwrap--full');

$('dbFull').addEventListener('click', () => setMapFull(!mapIsFull()));

// Esc fecha, que é o que todo mundo tenta antes de procurar o botão.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mapIsFull()) setMapFull(false);
});

/* --- credenciais do banco --------------------------------------------------
   Pedidas ao abrir a aba, guardadas so no navegador.

   A pagina e publica no GitHub Pages: qualquer chave versionada junto ficaria
   publica tambem. E servida pelo ESP32 nao ha rota para o Supabase, entao o
   formulario tambem nao atrapalha ali — quem abrir pela placa simplesmente nao
   vai preencher.

   localStorage e por navegador e por origem. Nao viaja, nao sincroniza, e some
   com "limpar dados do site" — que e exatamente o comportamento esperado de uma
   credencial digitada numa pagina de terceiro. */
const SB_STORE = 'lora2021.supabase';

function sbLoad() {
  try {
    const raw = localStorage.getItem(SB_STORE);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && c.url && c.key ? c : null;
  } catch {
    return null;
  }
}

function sbApply(cfg) {
  window.SUPABASE = cfg;
  const has = !!cfg;
  $('dbAuth').hidden = has;
  $('dbWho').hidden = !has;
  if (has) {
    // So o host, nunca a chave. Mostrar a credencial numa tela que alguem pode
    // estar projetando ou compartilhando nao ajuda em nada.
    $('dbHost').textContent = cfg.url.replace(/^https?:\/\//, '');
  }
}

$('sbSave').addEventListener('click', () => {
  const url = $('sbUrl').value.trim().replace(/\/+$/, '');
  const key = $('sbKey').value.trim();
  if (!/^https?:\/\/.+/.test(url) || key.length < 20) {
    dbNote('URL ou chave em branco / incompletas.');
    return;
  }
  const cfg = { url, key };
  try {
    localStorage.setItem(SB_STORE, JSON.stringify(cfg));
  } catch {
    // Navegacao privada pode recusar. Vale para esta sessao mesmo assim.
    dbNote('Nao consegui guardar — vai valer so ate fechar a aba.');
  }
  sbApply(cfg);
  $('sbKey').value = '';
  DB.list = [];
  void dbLoadList();
});

$('sbForget').addEventListener('click', () => {
  try {
    localStorage.removeItem(SB_STORE);
  } catch {
    /* nada a fazer */
  }
  sbApply(null);
  DB.list = [];
  DB.session = null;
  $('dbList').innerHTML = '';
  $('dbRows').innerHTML = '';
  $('dbStats').hidden = true;
  if (DB.layer) DB.layer.clearLayers();
  dbNote('Credenciais esquecidas neste navegador.');
});

// Restaura antes de qualquer troca de aba.
//
// O que foi DIGITADO no formulario tem precedencia sobre o arquivo local: quem
// trocou a credencial na tela esta corrigindo o arquivo, nao o contrario — e a
// ordem inversa faria "trocar" nunca pegar nesta maquina.
sbApply(sbLoad() || window.SUPABASE_LOCAL || null);
