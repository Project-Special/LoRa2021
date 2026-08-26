#!/usr/bin/env python3
"""Faz o PC bancar o radio de controle: injeta CRSF num modulo transmissor ELRS.

POR QUE ISTO EXISTE

Um transmissor ExpressLRS nao transmite sozinho. Sem CRSF chegando de um
handset ele nao tem dados RC pra mandar, entao simplesmente nao vai ao ar — e o
sintoma nao acusa a causa: o radio inicializa, o LED acende, e ninguem escuta
nada. Foi exatamente o que aconteceu na bancada, e custou uma caca a taxa de
pacote e a pinagem que estavam certas o tempo todo.

Com este script a UART do modulo recebe RC_CHANNELS_PACKED numa cadencia fixa, o
transmissor entra no ar e da pra medir alcance sem tirar o radio da mochila.

USO

    python tools/crsf_tx.py COM5                 # 16 canais no centro, 100 Hz
    python tools/crsf_tx.py COM5 --rate 250      # cadencia do handset real
    python tools/crsf_tx.py COM5 --sweep         # canal 1 varrendo, pra ver
                                                 # movimento do outro lado

FORMATO

    [addr][len][type][payload...][crc8]
      addr  0xEE  = modulo transmissor CRSF (e pra ele que o handset fala)
      len         = bytes de type ate crc8, inclusive
      type  0x16  = RC_CHANNELS_PACKED
      crc8        = CRC-8/DVB-S2 (poli 0xD5) sobre type + payload

O payload sao 16 canais de 11 bits, empacotados em 22 bytes sem alinhamento.
"""

import argparse
import sys
import time

import serial

ADDR_TX = 0xEE
TYPE_RC = 0x16

# Faixa do CRSF, em ticks. 172 e 1000 us, 1811 e 2000 us; 992 e o centro.
CH_MIN, CH_MID, CH_MAX = 172, 992, 1811


def crc8(data: bytes) -> int:
    """CRC-8/DVB-S2, poli 0xD5 — o do CRSF."""
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0xD5) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def pack_channels(ch: list) -> bytes:
    """16 canais de 11 bits em 22 bytes, little-endian contínuo."""
    bits = 0
    nbits = 0
    out = bytearray()
    for v in ch[:16]:
        v = max(0, min(0x7FF, int(v)))
        bits |= v << nbits
        nbits += 11
        while nbits >= 8:
            out.append(bits & 0xFF)
            bits >>= 8
            nbits -= 8
    if nbits:
        out.append(bits & 0xFF)
    return bytes(out[:22])


def rc_frame(ch: list) -> bytes:
    payload = pack_channels(ch)
    body = bytes([TYPE_RC]) + payload
    # len conta type + payload + crc
    return bytes([ADDR_TX, len(body) + 1]) + body + bytes([crc8(body)])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="porta serial do modulo (ex: COM5)")
    ap.add_argument("--baud", type=int, default=420000,
                    help="baud do CRSF (padrao 420000, o do ELRS)")
    ap.add_argument("--rate", type=int, default=100,
                    help="quadros por segundo (padrao 100)")
    ap.add_argument("--sweep", action="store_true",
                    help="varre o canal 1 de ponta a ponta, pra ver movimento")
    ap.add_argument("--seconds", type=float, default=0,
                    help="para depois deste tempo; 0 = ate Ctrl+C")
    args = ap.parse_args()

    ch = [CH_MID] * 16
    # Canais 5..8 nos extremos: dao um padrao reconhecivel do outro lado, o que
    # ajuda a distinguir "recebi dados" de "recebi zeros".
    ch[4], ch[5], ch[6], ch[7] = CH_MIN, CH_MAX, CH_MIN, CH_MAX

    s = serial.Serial()
    s.port = args.port
    s.baudrate = args.baud
    # O modulo nao usa as linhas de controle; mexer nelas so resetaria a placa.
    s.dtr = False
    s.rts = False
    s.open()

    period = 1.0 / args.rate
    t0 = time.time()
    sent = 0
    nxt = time.time()
    print(f"CRSF em {args.port} @ {args.baud} — {args.rate} quadros/s. Ctrl+C para parar.")
    try:
        while True:
            now = time.time()
            if args.seconds and now - t0 >= args.seconds:
                break
            if args.sweep:
                # Triangular de ~4 s, faixa inteira.
                phase = ((now - t0) % 4.0) / 4.0
                pos = phase * 2 if phase < 0.5 else (1 - phase) * 2
                ch[0] = int(CH_MIN + pos * (CH_MAX - CH_MIN))
            s.write(rc_frame(ch))
            sent += 1
            if sent % (args.rate * 5) == 0:
                print(f"  {sent} quadros ({(now - t0):.0f} s)")
            nxt += period
            delay = nxt - time.time()
            if delay > 0:
                time.sleep(delay)
            else:
                # Atrasou: reancora, senao o laco tenta recuperar pra sempre.
                nxt = time.time()
    except KeyboardInterrupt:
        pass
    finally:
        s.close()
    print(f"parado. {sent} quadros enviados.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
