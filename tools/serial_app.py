#!/usr/bin/env python3
r"""
Monitor serial do projeto LoRa2021.

Existe porque a UART deste projeto carrega duas coisas bem diferentes, e nenhum
monitor comum dá conta das duas:

    receptor ExpressLRS   CRSF binario a 420000 baud   (taxa que PuTTY, Arduino
                                                        IDE e cia. nem listam)
    firmware de bancada   texto a 115200, com console interativo

Entao o app abre em 420000 por padrao, detecta sozinho se o que esta chegando e
CRSF ou texto, e troca de visao. Em modo texto voce digita e o que for enviado
vai pro console da bancada (band, freq, pwr, peer, ...).

    python tools/serial_app.py                 COM5 a 420000 (receptor ELRS)
    python tools/serial_app.py -b 115200       bancada
    python tools/serial_app.py COM7 -b 9600
    python tools/serial_app.py --list          lista as portas

Precisa de pyserial. O python do PlatformIO ja tem:
    %USERPROFILE%\.platformio\penv\Scripts\python.exe tools/serial_app.py
"""

from __future__ import annotations

import argparse
import os
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit(
        "pyserial nao encontrado. Use o python do PlatformIO:\n"
        r"  %USERPROFILE%\.platformio\penv\Scripts\python.exe tools/serial_app.py"
    )

try:
    import msvcrt  # Windows: leitura de teclado sem bloquear
except ImportError:
    msvcrt = None

# ---------------------------------------------------------------------------
# CRSF
# ---------------------------------------------------------------------------

TYPE_LINK = 0x14
TYPE_RC = 0x16
ADDRESSES = (0xC8, 0xEA, 0xEC, 0xEE)

# Indice do campo uplink_TX_Power do CRSF -> mW
TX_POWER_MW = (0, 10, 25, 100, 500, 1000, 2000, 250, 50)


def crc8(data: bytes) -> int:
    """CRC-8/DVB-S2, polinomio 0xD5 — o do CRSF."""
    c = 0
    for x in data:
        c ^= x
        for _ in range(8):
            c = ((c << 1) ^ 0xD5) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def unpack_channels(payload: bytes) -> list[int]:
    """16 canais de 11 bits empacotados em 22 bytes, little-endian continuo."""
    bits = int.from_bytes(payload[:22], "little")
    return [(bits >> (11 * i)) & 0x7FF for i in range(16)]


def to_microseconds(value: int) -> int:
    """Escala do CRSF (172..1811, centro 992) para us de servo (988..2012)."""
    return round((value - 992) * 5 / 8 + 1500)


# ---------------------------------------------------------------------------
# Terminal
# ---------------------------------------------------------------------------

CSI = "\x1b["
DIM = CSI + "2m"
BOLD = CSI + "1m"
OFF = CSI + "0m"
AMBER = CSI + "38;5;214m"
CYAN = CSI + "38;5;51m"
GREEN = CSI + "38;5;46m"
RED = CSI + "38;5;203m"
GREY = CSI + "38;5;244m"


def enable_ansi() -> None:
    """Liga o processamento de escape ANSI no console do Windows."""
    if os.name != "nt":
        return
    try:
        import ctypes

        k = ctypes.windll.kernel32
        # -11 = STD_OUTPUT_HANDLE, 0x0004 = ENABLE_VIRTUAL_TERMINAL_PROCESSING
        handle = k.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(handle, ctypes.byref(mode)):
            k.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def bar(fraction: float, width: int) -> str:
    """Barra com resolucao de 1/8 de caractere."""
    fraction = max(0.0, min(1.0, fraction))
    total = int(round(fraction * width * 8))
    full, rest = divmod(total, 8)
    out = "█" * full
    if rest:
        out += " ▏▎▍▌▋▊▉"[rest]
    return out.ljust(width)


# ---------------------------------------------------------------------------
# Estado
# ---------------------------------------------------------------------------


class Monitor:
    def __init__(self, port: str, baud: int, force_raw: bool) -> None:
        self.port = port
        self.baud = baud
        self.force_raw = force_raw

        self.buf = bytearray()
        self.mode = "raw" if force_raw else "?"
        self.started = time.time()
        self.last_data = 0.0
        self.total_bytes = 0
        self.window: list[tuple[float, int]] = []

        self.rc_frames = 0
        self.link_frames = 0
        self.crc_errors = 0
        self.link: tuple[int, int, int, int, int, int] | None = None
        self.channels: list[int] = []

        self.lines: list[str] = []
        self.text_tail = ""
        self.outbox = ""

    # -- entrada -----------------------------------------------------------

    def feed(self, chunk: bytes) -> None:
        now = time.time()
        self.last_data = now
        self.total_bytes += len(chunk)
        self.window.append((now, len(chunk)))
        cutoff = now - 3.0
        while self.window and self.window[0][0] < cutoff:
            self.window.pop(0)

        self.buf += chunk

        if self.mode == "raw":
            self.parse_text()
            return

        # Enquanto o modo e "?" o buffer NAO pode ser consumido como texto: um
        # quadro CRSF chega picado entre leituras, e decodificar destruiria a
        # metade ja recebida antes do resto aparecer.
        self.parse_crsf()
        if self.mode == "crsf":
            return

        self.detect_mode()
        if self.mode == "raw":
            self.parse_text()

    def detect_mode(self) -> None:
        """
        Decide entre texto e binario pelo conteudo. So e chamado depois do
        parser CRSF nao ter achado quadro nenhum, entao a pergunta que resta e:
        isso e texto legivel, ou binario na taxa errada?
        """
        if len(self.buf) < 32:
            return
        sample = bytes(self.buf[-256:])
        printable = sum(1 for b in sample if 0x20 <= b < 0x7F or b in (0x09, 0x0A, 0x0D))
        if printable / len(sample) > 0.85:
            self.mode = "raw"

    def rate(self) -> float:
        """Bytes por segundo na janela dos ultimos 3 s."""
        if len(self.window) < 2:
            return 0.0
        span = self.window[-1][0] - self.window[0][0]
        if span <= 0:
            return 0.0
        return sum(n for _, n in self.window) / span

    # -- CRSF --------------------------------------------------------------

    def parse_crsf(self) -> None:
        """
        O CRSF nao tem byte de sincronismo, entao a varredura procura
        endereco + comprimento plausivel e so aceita o quadro se o CRC fechar.
        E o CRC que separa quadro de coincidencia.
        """
        i = 0
        consumed_any = False
        while i < len(self.buf) - 2:
            if self.buf[i] not in ADDRESSES:
                i += 1
                continue
            ln = self.buf[i + 1]
            if not (2 <= ln <= 62):
                i += 1
                continue
            if i + 2 + ln > len(self.buf):
                break  # quadro incompleto: espera mais bytes
            body = bytes(self.buf[i + 2 : i + 1 + ln])
            if crc8(body) != self.buf[i + 1 + ln]:
                self.crc_errors += 1
                i += 1
                continue

            consumed_any = True
            self.consume_frame(body)
            i += 2 + ln

        if consumed_any:
            if self.mode == "?":
                self.mode = "crsf"
            del self.buf[:i]
        elif len(self.buf) > 8192:
            del self.buf[:-256]

    def consume_frame(self, body: bytes) -> None:
        kind = body[0]
        if kind == TYPE_LINK and len(body) >= 11:
            p = body[1:]
            snr = p[3] if p[3] < 128 else p[3] - 256
            # rssi1, rssi2, lq, snr, rf_mode, tx_power
            self.link = (p[0], p[1], p[2], snr, p[5], p[6])
            self.link_frames += 1
        elif kind == TYPE_RC and len(body) >= 23:
            self.channels = unpack_channels(body[1:])
            self.rc_frames += 1

    # -- texto -------------------------------------------------------------

    def parse_text(self) -> None:
        try:
            text = self.buf.decode("utf-8")
        except UnicodeDecodeError:
            text = self.buf.decode("utf-8", "replace")
        self.buf.clear()
        self.text_tail += text
        while "\n" in self.text_tail:
            line, self.text_tail = self.text_tail.split("\n", 1)
            self.lines.append(line.rstrip("\r"))
        if len(self.lines) > 400:
            del self.lines[:-400]

    # -- desenho -----------------------------------------------------------

    def header(self) -> str:
        up = int(time.time() - self.started)
        mode = {"crsf": "CRSF", "raw": "texto", "?": "detectando"}[self.mode]
        rate = self.rate()
        unit = f"{rate / 1024:.1f} kB/s" if rate >= 1024 else f"{rate:.0f} B/s"
        return (
            f"{BOLD}{AMBER}LoRa2021{OFF}{GREY} · {OFF}{self.port}{GREY} · {OFF}"
            f"{self.baud} baud{GREY} · {OFF}{mode}{GREY} · {OFF}{unit}"
            f"{GREY}   {up // 60:02d}:{up % 60:02d}{OFF}"
        )

    def silence_note(self) -> str | None:
        if not self.last_data:
            return f"{GREY}aguardando dados em {self.port}...{OFF}"
        quiet = time.time() - self.last_data
        if quiet < 3.0:
            return None
        note = f"{RED}sem dados ha {int(quiet)} s{OFF}"
        # Pegadinha conhecida: o auto-WiFi do RX derruba o CRSF aos 30 s.
        if self.mode == "crsf" and quiet > 5:
            note += (
                f"{GREY}  — se o receptor foi gravado com --auto-wifi, ele sobe o"
                f" AP apos N s sem enlace e o CRSF para. Ligue o transmissor.{OFF}"
            )
        return note

    def render_crsf(self) -> list[str]:
        out = []
        if self.link:
            rssi1, rssi2, lq, snr, rf_mode, pwr_idx = self.link
            live = lq > 0
            color = GREEN if lq >= 70 else AMBER if lq > 0 else RED
            state = "conectado" if live else "SEM ENLACE"
            mw = TX_POWER_MW[pwr_idx] if pwr_idx < len(TX_POWER_MW) else pwr_idx

            out.append(f"  {color}{BOLD}{state}{OFF}")
            out.append("")
            out.append(
                f"  {GREY}LQ  {OFF}{color}{lq:3d} %{OFF}  {color}{bar(lq / 100, 28)}{OFF}"
            )
            out.append(
                f"  {GREY}RSSI{OFF} {-rssi1:4d} dBm"
                + (f"{GREY}  ant2 {OFF}{-rssi2} dBm" if rssi2 else "")
            )
            out.append(
                f"  {GREY}SNR {OFF} {snr:+4d} dB{GREY}    rf_mode {OFF}{rf_mode}"
                f"{GREY}    tx {OFF}{mw} mW"
            )
        else:
            out.append(f"  {GREY}sem LINK_STATISTICS ainda{OFF}")

        if self.channels:
            out.append("")
            out.append(f"  {GREY}canais RC{OFF}")
            half = 8
            for row in range(half):
                cells = []
                for col in (row, row + half):
                    if col >= len(self.channels):
                        continue
                    raw = self.channels[col]
                    frac = (raw - 172) / (1811 - 172)
                    us = to_microseconds(raw)
                    cells.append(
                        f"{GREY}CH{col + 1:<2d}{OFF} {CYAN}{bar(frac, 14)}{OFF}"
                        f" {us:4d}{GREY}us{OFF}"
                    )
                out.append("  " + "   ".join(cells))

        out.append("")
        out.append(
            f"  {GREY}quadros{OFF}  RC {self.rc_frames}{GREY} · {OFF}"
            f"LINK {self.link_frames}{GREY} · CRC ruim {self.crc_errors}{OFF}"
        )
        return out

    def render_raw(self, height: int) -> list[str]:
        tail = self.lines[-height:] if height > 0 else []
        out = ["  " + line[:160] for line in tail]
        if self.text_tail:
            out.append("  " + self.text_tail[:160] + f"{GREY}█{OFF}")
        return out

    def draw(self) -> None:
        try:
            size = os.get_terminal_size()
            width, height = size.columns, size.lines
        except OSError:
            width, height = 100, 30

        body = self.render_crsf() if self.mode == "crsf" else self.render_raw(height - 8)

        parts = [CSI + "H" + CSI + "2J", self.header(), ""]
        parts.extend(body)

        note = self.silence_note()
        if note:
            parts.extend(["", note])

        if self.mode != "crsf":
            parts.append("")
            parts.append(f"{GREY}> {OFF}{self.outbox}{GREY}█{OFF}")

        hint = "Ctrl+C encerra" if self.mode == "crsf" else "digite e Enter envia · Ctrl+C encerra"
        parts.append(f"{GREY}{hint}{OFF}")

        sys.stdout.write("\n".join(parts) + CSI + "J")
        sys.stdout.flush()

    # -- teclado -----------------------------------------------------------

    def pump_keyboard(self, port: serial.Serial) -> None:
        """Ecoa o teclado pro dispositivo. So faz sentido no console de texto."""
        if msvcrt is None:
            return
        while msvcrt.kbhit():
            ch = msvcrt.getwch()
            if ch in ("\r", "\n"):
                port.write((self.outbox + "\n").encode("utf-8", "replace"))
                self.lines.append(f"{CYAN}> {self.outbox}{OFF}")
                self.outbox = ""
            elif ch == "\b":
                self.outbox = self.outbox[:-1]
            elif ch == "\x03":
                raise KeyboardInterrupt
            elif ch.isprintable():
                self.outbox += ch


# ---------------------------------------------------------------------------


def pick_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    ports = list(list_ports.comports())
    if not ports:
        sys.exit("nenhuma porta serial encontrada. Ligue a placa ou passe a porta.")
    # Pontes USB-serial comuns em placas ESP32 (CH340, CP210x, FTDI).
    for p in ports:
        blob = f"{p.description} {p.manufacturer or ''}".lower()
        if any(k in blob for k in ("ch340", "cp210", "ftdi", "usb-serial", "silicon")):
            return p.device
    return ports[0].device


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Monitor serial do LoRa2021 (CRSF 420000 ou texto).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("port", nargs="?", help="COM5, /dev/ttyUSB0... (auto se omitido)")
    ap.add_argument(
        "-b", "--baud", type=int, default=420000,
        help="padrao 420000 (CRSF do receptor ELRS); a bancada usa 115200",
    )
    ap.add_argument("--raw", action="store_true", help="forca modo texto, sem tentar CRSF")
    ap.add_argument("--list", action="store_true", help="lista as portas e sai")
    args = ap.parse_args()

    if args.list:
        found = list(list_ports.comports())
        if not found:
            print("nenhuma porta serial encontrada.")
        for p in found:
            print(f"  {p.device:10s} {p.description}")
        return 0

    enable_ansi()
    port_name = pick_port(args.port)

    try:
        port = serial.Serial(port_name, args.baud, timeout=0.05)
    except serial.SerialException as exc:
        # De longe o erro mais comum aqui: outro monitor ja esta com a porta.
        return int(bool(sys.stderr.write(
            f"nao consegui abrir {port_name} a {args.baud}: {exc}\n"
            "Se a porta estiver ocupada, feche o outro monitor serial.\n"
        ))) or 1

    mon = Monitor(port_name, args.baud, args.raw)
    sys.stdout.write(CSI + "?25l")  # esconde o cursor
    last_draw = 0.0

    try:
        while True:
            chunk = port.read(4096)
            if chunk:
                mon.feed(chunk)
            if mon.mode != "crsf":
                mon.pump_keyboard(port)

            now = time.time()
            if now - last_draw >= 0.1:
                last_draw = now
                mon.draw()
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(CSI + "?25h" + "\n")  # devolve o cursor
        sys.stdout.flush()
        port.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
