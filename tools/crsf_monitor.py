#!/usr/bin/env python3
"""
Monitor do receptor ExpressLRS.

A UART do RX carrega CRSF binário a 420000 baud, não texto — abrir um monitor
serial comum ali mostra só lixo. Este script decodifica os quadros e mostra o
que interessa: qualidade de enlace, RSSI, SNR e os canais RC.

    python tools/crsf_monitor.py            # COM5 por padrao
    python tools/crsf_monitor.py COM7

Ctrl+C encerra. Precisa de pyserial (o do PlatformIO serve):
    %USERPROFILE%\\.platformio\\penv\\Scripts\\python.exe tools/crsf_monitor.py
"""

from __future__ import annotations

import sys
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial nao encontrado. Use o python do PlatformIO:\n"
             r"  %USERPROFILE%\.platformio\penv\Scripts\python.exe tools/crsf_monitor.py")

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM5"
BAUD = 420000

TYPE_LINK = 0x14
TYPE_RC = 0x16


def crc8(data: bytes) -> int:
    """CRC-8/DVB-S2, poli 0xD5 — o do CRSF."""
    c = 0
    for x in data:
        c ^= x
        for _ in range(8):
            c = ((c << 1) ^ 0xD5) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def unpack_channels(p: bytes) -> list[int]:
    """16 canais de 11 bits empacotados em 22 bytes."""
    bits = int.from_bytes(p[:22], "little")
    return [(bits >> (11 * i)) & 0x7FF for i in range(16)]


def main() -> None:
    s = serial.Serial(PORT, BAUD, timeout=0.2)
    print(f"lendo {PORT} a {BAUD} baud — Ctrl+C encerra\n")

    buf = bytearray()
    last_print = 0.0
    link = None
    chans: list[int] = []
    frames = 0

    try:
        while True:
            d = s.read(512)
            if d:
                buf += d

            # Sem sincronismo de quadro no CRSF: varre procurando endereço +
            # comprimento plausível e confirma pelo CRC.
            i = 0
            while i < len(buf) - 2:
                if buf[i] in (0xC8, 0xEA, 0xEC, 0xEE):
                    ln = buf[i + 1]
                    if 2 <= ln <= 62 and i + 2 + ln <= len(buf):
                        body = bytes(buf[i + 2 : i + 1 + ln])
                        if crc8(body) == buf[i + 1 + ln]:
                            frames += 1
                            if body[0] == TYPE_LINK and len(body) >= 11:
                                p = body[1:]
                                snr = p[3] if p[3] < 128 else p[3] - 256
                                link = (p[0], p[2], snr, p[5], p[6])
                            elif body[0] == TYPE_RC and len(body) >= 23:
                                chans = unpack_channels(body[1:])
                            i += 2 + ln
                            continue
                i += 1
            del buf[:i]
            if len(buf) > 4096:
                del buf[:-64]

            now = time.time()
            if now - last_print >= 0.5:
                last_print = now
                if link:
                    rssi, lq, snr, mode, pwr = link
                    estado = "SEM ENLACE" if lq == 0 else "conectado"
                    line = (f"{estado:10s}  LQ {lq:3d}%  RSSI -{rssi:3d} dBm  "
                            f"SNR {snr:+3d} dB  rf_mode {mode}  tx_pwr {pwr}")
                else:
                    line = f"aguardando quadros...  ({frames} lidos)"
                if chans:
                    line += "  |  CH1-4 " + " ".join(f"{c:4d}" for c in chans[:4])
                print("\r" + line.ljust(110), end="", flush=True)
    except KeyboardInterrupt:
        print("\n")
    finally:
        s.close()


if __name__ == "__main__":
    main()
