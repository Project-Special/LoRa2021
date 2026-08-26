#!/usr/bin/env python3
"""
Pré-visualização do painel sem ESP32.

Serve data/ e simula a API do firmware com valores que se mexem, pra dar pra
mexer no visual sem gravar a placa a cada ajuste.

    python tools/preview.py          # http://localhost:8080

Só biblioteca padrão.
"""

from __future__ import annotations

import json
import math
import random
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent.parent / "data"
PORT = 8080

BANDS = [
    ("150",   "150 MHz",         "Posição mais baixa da matriz do módulo — uso licenciado", 150.0, 125.0, 9, 22),
    ("433",   "433 MHz ISM",     "ISM região 1 / radioamador — conferir ciclo de trabalho local", 433.0,  125.0,  9, 22),
    ("470",   "470 MHz",         "Plano de banda CN470",                                 470.0,  125.0,  9, 22),
    ("868",   "868 MHz EU",      "EU868 — limite de +14 dBm ERP, 1% de ciclo de trabalho",        868.1,  125.0,  9, 14),
    ("915",   "915 MHz AU/US",   "AU915 / US915 — é o plano usado no Brasil",           915.0,  125.0,  9, 20),
    ("sband", "S-band 2.1 GHz",  "Banda de satélite LICENCIADA — só laboratório / teste",      2100.0,  125.0, 10, 12),
    ("2g4",   "2.4 GHz ISM",     "ISM mundial — banda larga, vazão bem maior", 2450.0, 203.125, 12, 12),
]

MATCH_OPTS = [150, 433, 470, 868, 915]

state = {
    "node": "7F3A",
    "band": "915",
    "freq": 915.0,
    "bw": 125.0,
    "sf": 9,
    "cr": 7,
    "power": 20,
    "beacon": True,
    "interval": 3000,
    "tx": 0,
    "rx": 0,
    "err": 0,
    "rtt": 0,
    "match": 915,          # rede de casamento soldada no modulo
}

log: list[dict] = []
seq = 0
t0 = time.time()


def add_log(kind: str, text: str) -> None:
    global seq
    log.append({"i": seq, "k": kind, "t": text})
    seq += 1
    del log[:-24]


def tick() -> None:
    """Faz o mundo simulado andar: beacon, recepção, RSSI oscilando."""
    if not state["beacon"]:
        return
    now = time.time()
    if now - tick.last < state["interval"] / 1000:
        return
    tick.last = now
    state["tx"] += 1
    add_log("tx", f"-> {state['node']}|{state['tx']}|BEACON|up={int(now - t0)}s")
    if random.random() > 0.12:
        state["rx"] += 1
        add_log("rx", f"<- A19C|{state['rx']}|BEACON|up={int(now - t0)}s  "
                      f"[{rssi():.1f} dBm / {snr():.1f} dB]")
    else:
        state["err"] += 1


tick.last = 0.0


def rssi() -> float:
    """Oscila devagar com um pouco de ruído — parece medida de verdade."""
    base = -72 if state["band"] == "2g4" else -88
    return base + 16 * math.sin((time.time() - t0) / 7.0) + random.uniform(-3, 3)


def snr() -> float:
    return 9 + 4 * math.sin((time.time() - t0) / 5.0) + random.uniform(-1, 1)


def band_row(alias):
    return next(b for b in BANDS if b[0] == alias)


def snapshot() -> bytes:
    hf = state["freq"] > 1090
    return json.dumps({
        **{k: state[k] for k in
           ("node", "band", "freq", "bw", "sf", "cr", "power", "beacon", "interval",
            "tx", "rx", "err", "rtt")},
        "hf": hf,
        "pmin": -19 if hf else -9,
        "pmax": 12 if hf else 22,
        "toa": int(2 ** state["sf"] * 1000 / state["bw"] * 1.4),
        "linked": state["rx"] > 0,
        "match": state["match"],
        "matchOpts": MATCH_OPTS,
        # mesma regra do firmware: tolerancia maior na posicao 150
        "mismatch": (not hf) and abs(state["freq"] - state["match"]) > (
            90 if state["match"] == 150 else 45),
        "rssi": round(rssi(), 1),
        "snr": round(snr(), 1),
        "bands": [{"id": b[0], "name": b[1], "note": b[2]} for b in BANDS],
        "log": log,
    }).encode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass

    def _json(self, payload: bytes, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/api/state"):
            tick()
            return self._json(snapshot())
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}

        if self.path.startswith("/api/config"):
            if "band" in form:
                row = band_row(form["band"])
                state.update(band=row[0], freq=row[3], bw=row[4], sf=row[5], power=row[6], cr=7)
            for key, cast in (("freq", float), ("bw", float), ("sf", int),
                              ("cr", int), ("power", int), ("interval", int)):
                if key in form:
                    state[key] = cast(float(form[key]))
            if "match" in form and int(form["match"]) in MATCH_OPTS:
                state["match"] = int(form["match"])
            if "beacon" in form:
                state["beacon"] = form["beacon"] == "1"
            # limite do PA muda com a banda, igual ao firmware
            hf = state["freq"] > 1090
            state["power"] = max(-19 if hf else -9, min(12 if hf else 22, state["power"]))
            state["band"] = min(
                BANDS, key=lambda b: abs(b[3] - state["freq"]))[0]
            return self._json(snapshot())

        if self.path.startswith("/api/send"):
            state["tx"] += 1
            add_log("tx", f"-> {form.get('text', 'hello')}")
            return self._json(b'{"ok":true}')

        if self.path.startswith("/api/ping"):
            state["tx"] += 1
            state["rtt"] = random.randint(90, 260)
            add_log("tx", "-> ping")
            add_log("sys", f"ida e volta: {state['rtt']} ms")
            return self._json(b'{"ok":true}')

        self.send_error(404)


if __name__ == "__main__":
    add_log("sys", "simulador — nenhum rádio de verdade nesta sessão")
    print(f"painel em http://localhost:{PORT}  (Ctrl+C para sair)")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
