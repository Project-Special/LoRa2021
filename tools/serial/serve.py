#!/usr/bin/env python3
"""
Serve o monitor serial em http://localhost:8081 e abre o navegador.

Existe por um motivo só: a Web Serial API exige contexto seguro. Alguns builds
do Chrome/Edge nao expoem navigator.serial em file://, e ai o botao CONECTAR
some sem explicar por que. Por localhost sempre funciona.

    python tools/serial/serve.py
    python tools/serial/serve.py 9000     porta alternativa

So biblioteca padrao. Ctrl+C encerra.
"""

from __future__ import annotations

import http.server
import os
import socketserver
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def end_headers(self):
        # Sem cache: editar o CSS e dar F5 tem que refletir na hora.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # o servidor e meio de transporte, nao o assunto


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
    url = f"http://localhost:{port}/"

    socketserver.TCPServer.allow_reuse_address = True
    try:
        server = socketserver.TCPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        print(f"nao consegui abrir a porta {port}: {exc}")
        print(f"tente outra: python {os.path.basename(__file__)} 9000")
        return 1

    print(f"monitor serial em {url}")
    print("use Chrome ou Edge — Firefox e Safari nao tem Web Serial")
    print("Ctrl+C encerra")

    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
