"""Reconstroi o JSON do painel a partir das strings de formato do molde.

Pega a classe de erro que quebrou o painel: campo escrito com um array ainda
ABERTO, virgula faltando, chave desbalanceada. Le a fonte de verdade -- o
painel_handlers.cpp.in -- e nao uma copia.
"""
import json
import re
import sys
from pathlib import Path

MOLDE = Path(sys.argv[1] if len(sys.argv) > 1 else "painel_handlers.cpp.in")
src = MOLDE.read_text(encoding="utf-8")

ini = src.index("static void HandlePainelState")
fim = src.index("AsyncWebServerResponse *r = request->beginResponse", ini)
corpo = src[ini:fim]

# Todas as chamadas snprintf que escrevem em buf, na ordem do codigo.
padrao = re.compile(
    r'snprintf\s*\(\s*buf[^,]*,\s*sizeof\(buf\)[^,]*,\s*((?:\s*"(?:[^"\\]|\\.)*")+)'
)
texto = ""
for m in padrao.finditer(corpo):
    texto += "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1)))

BARRA = chr(92)
texto = texto.replace(BARRA + '"', '"')

# Especificadores viram valores plausiveis. Cada laco conta como UMA iteracao,
# e cada #if como um ramo tomado -- o suficiente para a estrutura aparecer.
texto = re.sub(r"%\.\d+f", "1.5", texto)
texto = re.sub(r"%(?:hh|h|ll|l|z|j|t)?[diu]", "-7", texto)
texto = texto.replace("%02X", "AA")

# O separador condicional (primeiro ? "" : ",") na primeira iteracao e vazio.
texto = texto.replace('%s{', '{').replace('%s"', '"')
# Valores textuais escritos via %s.
for chave, valor in (
    ('"node":"%s"', '"node":"ELRS RX"'),
    ('"band":"%s"', '"band":"2g4"'),
    ('"nome":"%s"', '"nome":"EU433"'),
    ('"b":"%s"', '"b":"433"'),
    ('"hf":%s', '"hf":true'),
    ('"linked":%s', '"linked":true'),
    ('"ok":%s', '"ok":true'),
):
    texto = texto.replace(chave, valor)
texto = texto.replace("%s", "")

try:
    json.loads(texto)
    print("JSON do painel: VALIDO (%d bytes na simulacao)" % len(texto))
except Exception as e:
    print("JSON do painel: INVALIDO ->", e)
    pos = getattr(e, "pos", 0)
    print("...contexto:", repr(texto[max(0, pos - 120):pos + 60]))
    sys.exit(1)
