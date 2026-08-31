#!/usr/bin/env python3
"""
Aplica o suporte ao LR2021 sobre um clone do ExpressLRS 3.6.4.

Por que 3.6.4 e não a branch 4.2/lr2021: o IHM (e os transmissores comerciais
com que ele funciona) falam OTA v3, que é o da série 3.x. Ver README.md.

Estratégia: o LR2021 é, do ponto de vista do firmware, o mesmo caso do LR1121 —
rádio de banda dupla com bw2/sf2/cr2, tabela FHSS secundária e duas tabelas de
potência. Então o grosso do trabalho é ALARGAR as guardas `RADIO_LR1121`
existentes para aceitarem também `RADIO_LR2021`, e depois acrescentar as poucas
partes que são específicas do chip (driver, tabela de taxas, RATE_MAX).

Idempotente: pode rodar de novo depois de um `git pull` no clone.

    python apply_overlay.py
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = HERE.parent / "ExpressLRS-v3"
OLD_ADJUST = 'uint8_t adjustPacketRateForBaud(uint8_t rateIndex)\n{\n  return rateIndex = get_elrs_HandsetRate_max(rateIndex, handset->getMinPacketInterval());\n}'
NEW_ADJUST = 'uint8_t adjustPacketRateForBaud(uint8_t rateIndex)\n{\n  uint8_t adjusted = get_elrs_HandsetRate_max(rateIndex, handset->getMinPacketInterval());\n#if defined(RADIO_LR2021)\n  // overlay v3-lr2021: preservar a BANDA ao ajustar a taxa pelo handset.\n  //\n  // get_elrs_HandsetRate_max() procura na tabela pelo enum_rate que cabe no\n  // intervalo do handset, e devolve a PRIMEIRA entrada que serve. Na tabela do\n  // LR2021 as entradas sub-GHz vem antes das de 2.4 GHz, entao esse ajuste\n  // mudava de banda sem dizer nada — e o chamador ainda grava o resultado com\n  // config.SetRate(), tornando a troca permanente.\n  //\n  // Sintoma na bancada: transmissor configurado em 2.4 GHz subia em 900 MHz, e\n  // o receptor de 2.4 GHz simplesmente nao ouvia nada.\n  const uint8_t wantType = get_elrs_airRateConfig(rateIndex)->radio_type;\n  if (get_elrs_airRateConfig(adjusted)->radio_type != wantType)\n  {\n    const expresslrs_RFrates_e wantRate = get_elrs_airRateConfig(adjusted)->enum_rate;\n    for (uint8_t r = 0; r < RATE_MAX; r++)\n    {\n      if (get_elrs_airRateConfig(r)->radio_type == wantType &&\n          get_elrs_airRateConfig(r)->enum_rate == wantRate)\n      {\n        adjusted = r;\n        break;\n      }\n    }\n  }\n#endif\n  return adjusted;\n}'

SRC = CLONE / "src"
ELRS_TAG = "3.6.4"
ELRS_REPO = "https://github.com/ExpressLRS/ExpressLRS.git"

MARKER = "LR2021 overlay"

# Arquivos onde `RADIO_LR1121` significa "rádio de banda dupla" e o LR2021 se
# encaixa igual.
BROADEN = [
    "include/common.h",
    "include/targets.h",
    "src/common.cpp",
    "src/tx_main.cpp",
    "src/rx_main.cpp",
    "lib/CONFIG/config.cpp",
    "lib/DEVICE/device.cpp",
    "lib/FHSS/FHSS.cpp",
    "lib/FHSS/FHSS.h",
    "lib/LUA/rxtx_devLua.cpp",
    "lib/LUA/tx_devLUA.cpp",
    "lib/POWERMGNT/POWERMGNT.cpp",
    "lib/SCREEN/display.cpp",
]
# Deliberadamente de fora: lib/WIFI/lr1121.* e os trechos de devWIFI que servem
# pra atualizar o firmware DO LR1121 pela página web — é específico daquele chip.
# lib/LBT/* também fica de fora: só é exigido no domínio EU CE.


def run(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def ensure_clone() -> None:
    if (CLONE / ".git").exists():
        print(f"-> clone presente: {CLONE.name}")
        return
    print(f"-> clonando ExpressLRS {ELRS_TAG}")
    run("git", "clone", "--depth", "1", "--branch", ELRS_TAG, ELRS_REPO, str(CLONE))


def copy_driver() -> None:
    dst = SRC / "lib" / "LR2021Driver"
    dst.mkdir(parents=True, exist_ok=True)
    for f in (HERE / "lib" / "LR2021Driver").glob("*"):
        shutil.copy2(f, dst / f.name)
    shutil.copy2(
        HERE / "lib" / "SX12xxDriverCommon" / "SX12xxDriverCommon.h",
        SRC / "lib" / "SX12xxDriverCommon" / "SX12xxDriverCommon.h",
    )
    print("-> lib/LR2021Driver + SX12xxDriverCommon.h")


# Guardas que NÃO podem ser alargadas: são as que escolhem qual driver é
# instanciado e qual tabela de taxas existe. Se o LR2021 entrasse nelas, `Radio`
# e ExpressLRS_AirRateConfig seriam definidos duas vezes.
PROTECTED = [
    ('#if defined(RADIO_LR1121)\n\n#include "LR1121Driver.h"\nLR1121Driver DMA_ATTR Radio;'),
    ("#elif defined(RADIO_LR1121)\n#define RATE_MAX 16"),
]


def broaden_guards() -> None:
    """`defined(RADIO_LR1121)` -> `(defined(RADIO_LR1121) || defined(RADIO_LR2021))`"""
    pat = re.compile(r"defined\(RADIO_LR1121\)")
    for rel in BROADEN:
        p = SRC / rel
        text = p.read_text(encoding="utf-8", errors="surrogateescape")
        if "defined(RADIO_LR2021)" in text:
            continue

        # tira as guardas protegidas de cena, alarga o resto, devolve
        holds: list[str] = []
        for prot in PROTECTED:
            if prot in text:
                token = f"@@PROT{len(holds)}@@"
                text = text.replace(prot, token, 1)
                holds.append(prot)

        new = pat.sub("(defined(RADIO_LR1121) || defined(RADIO_LR2021))", text)

        for i, prot in enumerate(holds):
            new = new.replace(f"@@PROT{i}@@", prot, 1)

        if new != text or holds:
            p.write_text(new, encoding="utf-8", errors="surrogateescape")
            print(f"-> guardas alargadas: {rel}")


def insert_once(path: Path, anchor: str, block: str, tag: str, *, before: bool = False) -> None:
    text = path.read_text(encoding="utf-8", errors="surrogateescape")
    if tag in text:
        return
    if anchor not in text:
        sys.exit(f"âncora não encontrada em {path}:\n  {anchor!r}")
    text = text.replace(anchor, (block + anchor) if before else (anchor + block), 1)
    path.write_text(text, encoding="utf-8", errors="surrogateescape")
    print(f"-> bloco inserido: {path.relative_to(SRC)}")


def derive_rate_table() -> str:
    """Deriva a tabela de taxas do LR2021 a partir da do LR1121, no próprio clone.

    Mais seguro do que transcrever 14 linhas à mão, e acompanha o upstream se o
    clone mudar. Só as entradas LoRa: as duas de GFSK ficam de fora por ora.
    """
    text = (SRC / "src" / "common.cpp").read_text(encoding="utf-8", errors="surrogateescape")

    # Recorta só o bloco do LR1121: common.cpp tem as tabelas do SX127x e do
    # SX1280 antes dele, e um re.search solto pegaria a primeira que aparecesse.
    start = text.find('#include "LR1121Driver.h"')
    end = text.find("#endif", start)
    if start < 0 or end < 0:
        sys.exit("não achei o bloco do LR1121 em common.cpp")
    text = text[start:end]

    mod = re.search(
        r"expresslrs_mod_settings_s ExpressLRS_AirRateConfig\[RATE_MAX\] = \{(.*?)\};",
        text, re.S)
    perf = re.search(
        r"expresslrs_rf_pref_params_s ExpressLRS_AirRateRFperf\[RATE_MAX\] = \{(.*?)\};",
        text, re.S)
    if not mod or not perf:
        sys.exit("não achei as tabelas de taxa do LR1121 no clone")

    def rows(body: str) -> list[str]:
        out = []
        for ln in body.splitlines():
            if not ln.strip().startswith("{"):
                continue
            # Tira comentário de fim de linha: senão o fechamento que eu acrescento
            # depois cairia DENTRO do comentário e a linha perderia o `},`.
            ln = re.sub(r"\s*//.*$", "", ln)
            out.append(ln.rstrip().rstrip(",").rstrip("}"))
        return out

    mod_rows = [r for r in rows(mod.group(1)) if "GFSK" not in r]
    perf_rows = rows(perf.group(1))[: len(mod_rows)]

    def convert(line: str) -> str:
        line = line.replace("LR11XX_RADIO_", "LR2021_RADIO_")
        return line.replace("RADIO_TYPE_LR1121_", "RADIO_TYPE_LR2021_")

    mod_txt = "\n".join(convert(r) + "}," for r in mod_rows).rstrip(",") + "};"
    perf_txt = "\n".join(r + "}," for r in perf_rows).rstrip(",") + "};"

    return f"""
// ---- {MARKER} ----------------------------------------------------------
// Tabela derivada da do LR1121 (mesma modulação, mesmos enum_rate), só trocando
// as constantes de registrador. É isso que faz o enlace ser compatível com
// peers ExpressLRS 3.x nas duas bandas — inclusive com o SX1280, cuja BW de
// 812 kHz o LR2021 reproduz (LR2021_RADIO_LORA_BW_800, "compatible with LR112x").
//
// O índice 9 (2.4 GHz, 50 Hz, BW 800 / SF8 / CR LI 4/8) é o que casa com o
// rateIndex 9 do IHM. Os índices 10 e 11 são dual band e só ficam disponíveis
// quando existe um SEGUNDO módulo (radio_nss_2) — ver isSupportedRFRate.
#if defined(RADIO_LR2021)

#include "LR2021Driver.h"
LR2021Driver DMA_ATTR Radio;

expresslrs_mod_settings_s ExpressLRS_AirRateConfig[RATE_MAX] = {{
{mod_txt}

expresslrs_rf_pref_params_s ExpressLRS_AirRateRFperf[RATE_MAX] = {{
{perf_txt}
#endif
"""


def patch_common_cpp() -> None:
    p = SRC / "src" / "common.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    if MARKER in text:
        print("-> src/common.cpp (já aplicado)")
        return
    anchor = "#if defined(RADIO_SX128X)"
    if anchor not in text:
        sys.exit("âncora RADIO_SX128X não encontrada em common.cpp")
    text = text.replace(anchor, derive_rate_table() + "\n" + anchor, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> src/common.cpp: tabela de taxas do LR2021")


def patch_common_h() -> None:
    p = SRC / "include" / "common.h"

    insert_once(p, "    RADIO_TYPE_SX128x_FLRC,\n};\n", f"""
// {MARKER}: mesmos papéis do LR1121, registradores do LR2021.
enum {{
    RADIO_TYPE_LR2021_LORA_900 = RADIO_TYPE_SX128x_FLRC + 1,
    RADIO_TYPE_LR2021_LORA_2G4,
    RADIO_TYPE_LR2021_GFSK_900,
    RADIO_TYPE_LR2021_GFSK_2G4,
    RADIO_TYPE_LR2021_LORA_DUAL,
}};

// Só um rádio é compilado por vez, então na build do LR2021 os nomes LR1121
// passam a apontar pros tipos do LR2021. Assim todo o código que as guardas
// alargadas passaram a compartilhar (isSupportedRFRate, LUA, POWERMGNT...)
// continua escrito em termos de LR1121 e funciona sem alteração.
#if defined(RADIO_LR2021)
#define RADIO_TYPE_LR1121_LORA_900  RADIO_TYPE_LR2021_LORA_900
#define RADIO_TYPE_LR1121_LORA_2G4  RADIO_TYPE_LR2021_LORA_2G4
#define RADIO_TYPE_LR1121_GFSK_900  RADIO_TYPE_LR2021_GFSK_900
#define RADIO_TYPE_LR1121_GFSK_2G4  RADIO_TYPE_LR2021_GFSK_2G4
#define RADIO_TYPE_LR1121_LORA_DUAL RADIO_TYPE_LR2021_LORA_DUAL
#endif
""", tag="RADIO_TYPE_LR2021_LORA_900")

    insert_once(p, "#elif defined(RADIO_SX128X)\n#define RATE_MAX 10", f"""#elif defined(RADIO_LR2021)   // {MARKER}
#define RATE_MAX 14              // 4x LoRa 900 + 6x LoRa 2G4 + 2x dual + 2x LoRa 900
#define RATE_BINDING RATE_LORA_50HZ
#define RATE_DUALBAND_BINDING 9  // 2.4GHz 50Hz

extern LR2021Driver Radio;

""", tag="#elif defined(RADIO_LR2021)", before=True)


def patch_driver_includes() -> None:
    """Nas guardas alargadas, `#include "LR1121Driver.h"` passaria a valer também
    na build do LR2021 — e aquele driver está no lib_ignore. Troca pelo par
    condicional em todo arquivo que inclui o driver."""
    old = '#include "LR1121Driver.h"'
    new = f'''#if defined(RADIO_LR2021)   // {MARKER}
#include "LR2021Driver.h"
#else
#include "LR1121Driver.h"
#endif'''
    for rel in BROADEN:
        p = SRC / rel
        text = p.read_text(encoding="utf-8", errors="surrogateescape")
        if old not in text or "LR2021Driver.h" in text:
            continue
        p.write_text(text.replace(old, new), encoding="utf-8", errors="surrogateescape")
        print(f"-> include do driver: {rel}")


def patch_rate_band_lock() -> None:
    """O ajuste de taxa pelo handset nao pode trocar a BANDA.

    get_elrs_HandsetRate_max() casa por enum_rate e devolve a primeira entrada
    que serve; na tabela do LR2021 as sub-GHz vem antes das de 2.4 GHz. O
    chamador grava o resultado com config.SetRate(), entao a troca vira
    permanente -- um transmissor posto em 2.4 GHz acorda em 900 MHz.
    """
    p = SRC / "src" / "tx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    if "preservar a BANDA ao ajustar a taxa" in text:
        print("-> tx_main.cpp: banda da taxa (ja aplicado)")
        return
    old = OLD_ADJUST
    if old not in text:
        print("-> tx_main.cpp: PADRAO NAO ENCONTRADO, banda da taxa nao travada")
        return
    p.write_text(text.replace(old, NEW_ADJUST), encoding="utf-8", errors="surrogateescape")
    print("-> tx_main.cpp: taxa nao troca mais de banda")


def patch_default_rate() -> None:
    """A taxa de fabrica do transmissor precisa ser a de 2.4 GHz.

    O upstream escolhe RATE_LORA_200HZ para LR1121/LR2021, e enumRatetoIndex()
    devolve a PRIMEIRA entrada da tabela com esse enum. Na tabela do LR2021 essa
    entrada e RADIO_TYPE_LR2021_LORA_900 -- sub-GHz.

    Num modulo dual sem handset ligado, nada troca essa taxa: o transmissor sobe
    em 900 MHz e fica mudo para quem escuta 2.4 GHz. E o sintoma nao aponta a
    causa nenhuma -- o radio inicializa, transmite, e simplesmente ninguem ouve.

    Aqui a taxa de fabrica passa a ser procurada na tabela pelos DOIS campos:
    banda 2.4 GHz e 50 Hz, que e o alvo do enlace deste projeto.
    """
    p = SRC / "lib" / "CONFIG" / "config.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    old = """        #elif (defined(RADIO_LR1121) || defined(RADIO_LR2021))
            SetRate(enumRatetoIndex(POWER_OUTPUT_VALUES_COUNT == 0 ? RATE_LORA_250HZ : RATE_LORA_200HZ));"""
    new = """        #elif defined(RADIO_LR2021)
            // overlay v3-lr2021: taxa de fabrica em 2.4 GHz, nao sub-GHz.
            // enumRatetoIndex(RATE_LORA_200HZ) cairia na primeira entrada com
            // esse enum, que na tabela do LR2021 e RADIO_TYPE_LR2021_LORA_900.
            {
                uint8_t rateIdx = enumRatetoIndex(RATE_LORA_200HZ);
                for (uint8_t r = 0; r < RATE_MAX; r++)
                {
                    if (get_elrs_airRateConfig(r)->radio_type == RADIO_TYPE_LR2021_LORA_2G4 &&
                        get_elrs_airRateConfig(r)->enum_rate == RATE_LORA_50HZ)
                    {
                        rateIdx = r;
                        break;
                    }
                }
                SetRate(rateIdx);
            }
        #elif defined(RADIO_LR1121)
            SetRate(enumRatetoIndex(POWER_OUTPUT_VALUES_COUNT == 0 ? RATE_LORA_250HZ : RATE_LORA_200HZ));"""
    if new.strip() in text:
        print("-> config.cpp: taxa de fabrica (ja aplicado)")
        return
    if old not in text:
        print("-> config.cpp: PADRAO NAO ENCONTRADO, taxa de fabrica nao aplicada")
        return
    p.write_text(text.replace(old, new), encoding="utf-8", errors="surrogateescape")
    print("-> config.cpp: taxa de fabrica = 2.4 GHz 50 Hz")


def patch_hardware_fields() -> None:
    """radio_tcxo / radio_tcxo_delay são campos de layout que só nasceram na 4.x;
    o LR2021Driver os lê no Begin() para configurar o TCXO."""
    insert_once(SRC / "include" / "hardware.h",
                "    HARDWARE_radio_rfsw_ctrl_count,\n",
                f"    // {MARKER}\n    HARDWARE_radio_tcxo,\n    HARDWARE_radio_tcxo_delay,\n",
                tag="HARDWARE_radio_tcxo")
    insert_once(SRC / "lib" / "OPTIONS" / "hardware.cpp",
                '    {HARDWARE_radio_rfsw_ctrl_count, "radio_rfsw_ctrl", COUNT},\n',
                f'    // {MARKER}\n'
                '    {HARDWARE_radio_tcxo, "radio_tcxo", INT},\n'
                '    {HARDWARE_radio_tcxo_delay, "radio_tcxo_delay", INT},\n',
                tag="radio_tcxo")


def install_hardware() -> None:
    """O firmware 'Unified' lê o layout de pinos de src/hardware, que é o repo
    ExpressLRS/targets. Clona e injeta os nossos layouts."""
    import json

    hw = SRC / "hardware"
    if not (hw / ".git").exists():
        if hw.exists() and any(hw.iterdir()):
            sys.exit(f"{hw} existe mas não é um checkout git - remova antes")
        print("-> clonando ExpressLRS/targets")
        run("git", "clone", "--depth", "1",
            "https://github.com/ExpressLRS/targets.git", str(hw))

    for side in ("TX", "RX"):
        dst = hw / side
        dst.mkdir(parents=True, exist_ok=True)
        for layout in (HERE / "hardware" / side).glob("*.json"):
            shutil.copy2(layout, dst / layout.name)
            print(f"-> {side}/{layout.name}")

    tpath = hw / "targets.json"
    targets = json.loads(tpath.read_text(encoding="utf-8"))
    partial = json.loads((HERE / "hardware" / "targets.partial.json").read_text(encoding="utf-8"))
    targets.update(partial)
    tpath.write_text(json.dumps(targets, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
    print("-> targets.json: lora2021")


def install_user_defines() -> None:
    shutil.copy2(HERE / "user_defines.txt", SRC / "user_defines.txt")
    print("-> user_defines.txt")


def patch_targets_ini() -> None:
    # No fim do arquivo de propósito: inserir logo após o `build_flags` do
    # [radio_LR1121] colocaria a seção nova DENTRO dela, e o lib_ignore do
    # LR1121 viraria um segundo lib_ignore do LR2021.
    p = SRC / "targets" / "common.ini"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    if "[radio_LR2021]" in text:
        return
    text += f"""

[radio_LR2021]   ; {MARKER}
build_flags = -DRADIO_LR2021=1
lib_ignore =
\tSX127xDriver
\tSX1280Driver
\tLR1121Driver
"""
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> targets/common.ini: [radio_LR2021]")


def patch_build_html() -> None:
    """O gerador da página web deduz o chip pela build flag; sem o ramo do
    LR2021 a variável `chip` fica indefinida e o build morre antes de compilar."""
    p = SRC / "python" / "build_html.py"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    if "RADIO_LR2021" in text:
        return
    text = text.replace(
        "has_sub_ghz = '-DRADIO_SX127X=1' in env['BUILD_FLAGS'] or '-DRADIO_LR1121=1' in env['BUILD_FLAGS']",
        "has_sub_ghz = '-DRADIO_SX127X=1' in env['BUILD_FLAGS'] or '-DRADIO_LR1121=1' in env['BUILD_FLAGS']"
        " or '-DRADIO_LR2021=1' in env['BUILD_FLAGS']", 1)
    text = text.replace(
        "    elif '-DRADIO_LR1121=1' in env['BUILD_FLAGS']:\n        chip = 'LR1121'",
        "    elif '-DRADIO_LR1121=1' in env['BUILD_FLAGS']:\n        chip = 'LR1121'\n"
        "    elif '-DRADIO_LR2021=1' in env['BUILD_FLAGS']:\n"
        "        chip = 'LR1121'   # LR2021 overlay: a UI trata os dois como banda dupla", 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> python/build_html.py: chip do LR2021")


def patch_unified_ini() -> None:
    """Cria as envs do LR2021 espelhando as do LR1121."""
    p = SRC / "targets" / "unified.ini"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")
    if "LoRa2021_TX" in text:
        print("-> targets/unified.ini (já aplicado)")
        return

    def clone_env(name: str) -> str:
        m = re.search(rf"\[env:{name}\]\n(.*?)(?=\n\[env:)", text, re.S)
        if not m:
            sys.exit(f"env {name} não encontrada em unified.ini")
        return m.group(1).replace("radio_LR1121", "radio_LR2021")

    text += f"""

# ---- {MARKER} --------------------------------------------------------------
# board_config amarrado: sem ele o pós-build abre um menu interativo pedindo o
# target, o que quebra build automatizado.

[env:LoRa2021_TX]
{clone_env("Unified_ESP32_LR1121_TX_via_ETX")}board_config = lora2021.tx_dual.esp32

[env:LoRa2021_RX]
{clone_env("Unified_ESP32_LR1121_RX_via_UART")}board_config = lora2021.rx_dual.esp32

# ESP32-S3 — é a placa em uso, com a pinagem do SX1280 da IHM
[env:LoRa2021_S3_TX]
{clone_env("Unified_ESP32S3_LR1121_TX_via_ETX")}board_config = lora2021.tx_dual.esp32s3

[env:LoRa2021_S3_RX]
{clone_env("Unified_ESP32S3_LR1121_RX_via_UART")}board_config = lora2021.rx_dual.esp32s3
"""
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> targets/unified.ini: envs LoRa2021_TX / LoRa2021_RX")


def patch_rx_led() -> None:
    """LED do receptor na convencao DESTE projeto, nao na do upstream.

    A bancada usa, desde o inicio, uma convencao em que a gravidade cresce com
    a AUSENCIA de luz:

        apagado   modulo LoRa2021 nao encontrado
        aceso     radio ok, sem comunicacao com o transmissor
        piscando  comunicacao ativa

    O ExpressLRS usa quase o inverso -- pisca procurando e fica aceso quando
    conecta. Isso importa mais do que parece: as duas placas ficam lado a lado
    na bancada, e ler a mesma luz com dois significados opostos e como ter dois
    manometros girando para lados diferentes.

    O que NAO e tocado: bind e WiFi mantem os padroes do upstream. Sao modos
    transitorios que o operador aciona de proposito, e aquele padrao e a unica
    sinalizacao que eles tem.
    """
    p = SRC / "lib" / "LED" / "devLED.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: convencao de LED do projeto"
    if marca in text:
        print("-> devLED.cpp: convencao de LED (ja aplicado)")
        return

    seq_old = "constexpr uint8_t LEDSEQ_DISCONNECTED[] = { 50, 50 };  // 500ms on, 500ms off"
    seq_new = seq_old + """
// overlay v3-lr2021: 150 ms, o mesmo periodo do status_led.cpp da bancada.
// Rapido o bastante para ler como "piscando" de relance, lento o bastante para
// nao virar brilho continuo aos olhos.
constexpr uint8_t LEDSEQ_PROJ_ATIVO[] = { 15, 15 };"""
    if seq_old not in text:
        print("-> devLED.cpp: SEQUENCIA NAO ENCONTRADA")
        return
    text = text.replace(seq_old, seq_new, 1)

    alvo = """    switch (connectionState)
    {
    case connected:"""
    novo = """    #if defined(TARGET_RX)
    // overlay v3-lr2021: convencao de LED do projeto -- ver patch_rx_led().
    //   apagado  = radio nao encontrado
    //   aceso    = radio ok, sem transmissor
    //   piscando = comunicacao ativa
    if (GPIO_PIN_LED != UNDEF_PIN && !InBindingMode &&
        connectionState != wifiUpdate)
    {
        if (connectionState == radioFailed)
        {
            digitalWrite(GPIO_PIN_LED, LOW ^ GPIO_LED_RED_INVERTED);
            return DURATION_NEVER;
        }
        if (connectionState == connected)
        {
            return flashLED(GPIO_PIN_LED, GPIO_LED_RED_INVERTED,
                            LEDSEQ_PROJ_ATIVO, sizeof(LEDSEQ_PROJ_ATIVO));
        }
        digitalWrite(GPIO_PIN_LED, HIGH ^ GPIO_LED_RED_INVERTED);
        return DURATION_NEVER;
    }
    #endif

    switch (connectionState)
    {
    case connected:"""
    if alvo not in text:
        print("-> devLED.cpp: SWITCH NAO ENCONTRADO")
        return
    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> devLED.cpp: convencao de LED do projeto")


def patch_s3_serial() -> None:
    """Serial do S3 na ponte CH340 (UART0), nao no USB nativo.

    O env_common_esp32s3tx do upstream traz -D ARDUINO_USB_CDC_ON_BOOT, que
    manda o `Serial` para o USB NATIVO do S3. Faz sentido para placas ligadas
    por aquele conector -- e NAO e o caso desta: o LoRa2021 em DevKitC-1
    conversa pela ponte CH340 no UART0, e e por ela que o CRSF do handset entra.

    Com o CDC ligado o firmware fala e escuta numa porta que nao existe neste
    setup, e o sintoma engana: a porta COM aparece do mesmo jeito (o CH340
    enumera sozinho, sem firmware nenhum), o transmissor inicializa, e nada vai
    ao ar. Foi exatamente isto que segurou a bancada -- 3000 quadros CRSF
    injetados sem um unico pacote transmitido, porque o firmware nunca os
    recebeu.

    O mesmo raciocinio ja esta no platformio.ini da bancada, para o firmware
    proprio. Aqui e a mesma placa e o mesmo cabo.
    """
    p = SRC / "targets" / "unified.ini"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    # A marca e o proprio flag, e nao um comentario: dentro de build_flags o
    # PlatformIO repassa a linha de ";" ao compilador, que responde
    # "macro names must be identifiers". A explicacao vive nesta docstring.
    marca = "ARDUINO_USB_CDC_ON_BOOT=0"
    if marca in text:
        print("-> unified.ini: serial do S3 (ja aplicado)")
        return

    # ACRESCENTA aos build_flags que ja existem no env, em vez de declarar um
    # segundo `build_flags =`: o INI nao acumula chaves repetidas, e o
    # PlatformIO recusa o arquivo inteiro com "option already exists".
    #
    # A ancora e a linha de flags comuns do S3, que so aparece nos dois envs do
    # S3 -- e sao exatamente esses os que precisam do ajuste.
    TAB = chr(9)
    NL = chr(10)
    ancora = TAB + "${env_common_esp32s3tx.build_flags}"
    if ancora not in text:
        print("-> unified.ini: ANCORA DO S3 NAO ENCONTRADA")
        return

    extra = NL.join([
        ancora,
        # Sem espaco depois do -U: o PlatformIO quebra "-U NOME" em dois
        # tokens e o -U acaba engolindo o proximo flag da lista (virou
        # "-U -Isrc", e o gcc respondeu "macro names must be identifiers").
        TAB + "-UARDUINO_USB_CDC_ON_BOOT",
        TAB + "-D ARDUINO_USB_MODE=1",
        TAB + "-D ARDUINO_USB_CDC_ON_BOOT=0",
    ])

    n = text.count(ancora)
    text = text.replace(ancora, extra)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> unified.ini: serial do S3 na ponte CH340 (%d env)" % n)


def patch_rx_wifi() -> None:
    """WiFi do receptor na regra DESTE projeto, nao na do ExpressLRS.

    O upstream trata WiFi como MODO DE ATUALIZACAO: ao subir o AP ele poe
    connectionState = wifiUpdate, e o rx_main pula o laco de radio inteiro
    (`if (connectionState > MODE_STATES) return;`). Resultado na bancada: o AP
    sobe sozinho apos N segundos sem enlace, o CRSF na UART para, e o receptor
    parece travado -- foi exatamente o que aconteceu aqui.

    A regra deste projeto e a do painel da bancada (WebConfig::kApGraceMs):

        o AP sobe no boot e fica 2 MINUTOS esperando alguem entrar;
        ninguem entrou   -> desliga o WiFi sozinho;
        alguem entrou    -> fica de pe ate o proximo reset;
        e o RADIO NUNCA PARA por causa disso.

    Para o radio continuar, o AP e ligado por uma flag propria em vez de
    connectionState -- assim nada em rx_main enxerga "modo de atualizacao".

    CUSTO CONHECIDO, e ele e fisico: o radio WiFi do ESP32 e 2,4 GHz, a mesma
    banda do enlace ExpressLRS. Enquanto o AP estiver no ar ele dessensibiliza o
    proprio receptor da placa. Foi por isso que o painel da bancada aprendeu a
    se desligar sozinho; aqui a janela de 2 minutos limita o estrago.
    """
    p = SRC / "lib" / "WIFI" / "devWIFI.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: AP convive com o radio"
    if marca in text:
        print("-> devWIFI.cpp: WiFi do projeto (ja aplicado)")
        return

    # 1. estado proprio, ao lado dos globais que ja existem
    a1 = "static bool force_update = false;"
    n1 = """// """ + marca + """.
//
// Nao usamos connectionState = wifiUpdate para ligar o AP: aquele estado faz o
// rx_main pular o laco de radio inteiro. Com uma flag separada o servidor web
// sobe e o enlace continua vivo.
static bool apCoexist = false;      // AP no ar SEM parar o radio
static bool apKeep = false;         // alguem entrou: nao desliga mais
static uint32_t apDeadline = 0;     // fim da janela de cortesia

// Dois minutos, o mesmo de WebConfig::kApGraceMs no firmware de bancada.
// Tempo de sacar o celular, achar a rede e abrir a pagina -- e curto o
// bastante para o AP nao ficar dessensibilizando o receptor a campanha toda.
static constexpr uint32_t AP_GRACE_MS = 120000;

static bool force_update = false;"""
    if a1 not in text:
        print("-> devWIFI.cpp: ANCORA DE GLOBAIS NAO ENCONTRADA")
        return
    text = text.replace(a1, n1, 1)

    # 2. event(): sobe o AP tambem pela flag, e nao o derruba enquanto ela valer
    a2b = "static int event()" + chr(10) + "{"
    n2b = ("static int event()" + chr(10) + "{" + chr(10) +
           "  // Arma o AP aqui tambem, e nao so no timeout(): no transmissor o"
           + chr(10) +
           "  // watchdog de UART mexe em connectionState a cada volta, o framework"
           + chr(10) +
           "  // trata como evento continuo, e o timeout agendado nunca chega a vez."
           + chr(10) +
           "  if (!wifiStarted && !apCoexist && millis() > AP_BOOT_DELAY_MS)" + chr(10) +
           "  {" + chr(10) +
           "    apCoexist = true;" + chr(10) +
           "    apDeadline = millis() + AP_GRACE_MS;" + chr(10) +
           "    apKeep = false;" + chr(10) +
           "  }" + chr(10))
    if a2b in text:
        text = text.replace(a2b, n2b, 1)

    a2 = """  if (connectionState == wifiUpdate || connectionState > FAILURE_STATES)
  {
    if (!wifiStarted) {
      startWiFi(millis());
      return DURATION_IMMEDIATELY;
    }
  }
  else if (wifiStarted)"""
    n2 = """  if (connectionState == wifiUpdate || connectionState > FAILURE_STATES || apCoexist)
  {
    if (!wifiStarted) {
      startWiFi(millis());
      apDeadline = millis() + AP_GRACE_MS;
      apKeep = false;
      return DURATION_IMMEDIATELY;
    }
  }
  else if (wifiStarted)"""
    if a2 not in text:
        print("-> devWIFI.cpp: ANCORA DO event() NAO ENCONTRADA")
        return
    text = text.replace(a2, n2, 1)

    # 3. timeout(): janela de cortesia de 2 min
    a3 = """  if (wifiStarted)
  {
    HandleWebUpdate();
    HandleMSP2WIFI();"""
    n3 = """  if (wifiStarted)
  {
    HandleWebUpdate();
    HandleMSP2WIFI();

    // Janela de cortesia. Basta UMA estacao associada dentro dela para o AP
    // ficar de pe ate o proximo reset -- quem abriu o painel esta usando.
    if (apCoexist && !apKeep)
    {
      if (WiFi.softAPgetStationNum() > 0)
      {
        apKeep = true;
        DBGLN("AP acessado, fica no ar ate o proximo reset");
      }
      else if ((int32_t)(millis() - apDeadline) >= 0)
      {
        DBGLN("Ninguem acessou o AP em %u s, desligando o WiFi", AP_GRACE_MS / 1000);
        apCoexist = false;
        return DURATION_IMMEDIATELY;
      }
    }
    #endif"""
    if a3 not in text:
        print("-> devWIFI.cpp: ANCORA DO timeout() NAO ENCONTRADA")
        return
    text = text.replace(a3, n3, 1)

    # 4. start(): no RX o AP sobe no boot, e o auto-start do upstream sai de cena
    a4 = """static int start()
{
  ipAddress.fromString(wifi_ap_address);
  return firmwareOptions.wifi_auto_on_interval;
}"""
    n4 = """static int start()
{
  ipAddress.fromString(wifi_ap_address);
  // O AP sobe JA, e nao depois de N segundos sem enlace. O gatilho do upstream
  // e "desisti de achar o transmissor"; aqui o painel e ferramenta de bancada e
  // precisa estar disponivel desde o inicio, inclusive com o enlace vivo.
  apCoexist = true;
  return DURATION_IMMEDIATELY;
  #else
  return firmwareOptions.wifi_auto_on_interval;
  #endif
}"""
    if a4 not in text:
        print("-> devWIFI.cpp: ANCORA DO start() NAO ENCONTRADA")
        return
    text = text.replace(a4, n4, 1)

    # 5. desliga o auto-start do upstream no RX: ele poria connectionState em
    #    wifiUpdate e mataria o radio, que e justamente o que se quer evitar.
    a5 = """  #elif defined(TARGET_RX)
  if (firmwareOptions.wifi_auto_on_interval != -1 && !webserverPreventAutoStart && (connectionState == disconnected))"""
    n5 = """  #elif defined(TARGET_RX)
  // Auto-start do upstream DESLIGADO: ele chama setWifiUpdateMode(), que poe
  // connectionState = wifiUpdate e faz o rx_main parar o radio. Quem sobe o AP
  // aqui e apCoexist, em start(), sem tocar em connectionState.
  if (false)"""
    if a5 not in text:
        print("-> devWIFI.cpp: ANCORA DO AUTO-START NAO ENCONTRADA")
        return
    text = text.replace(a5, n5, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> devWIFI.cpp: AP de 2 min, convivendo com o radio")


def patch_wifi_keep_radio() -> None:
    """startWiFi() para de desligar o radio quando o AP e do nosso modo.

    Complemento de patch_rx_wifi(). La eu evitei por connectionState em
    wifiUpdate por fora -- e nao adiantou, porque o proprio startWiFi() faz
    isso por dentro, junto com hwTimer::stop() e Radio.End():

        if (connectionState < FAILURE_STATES) {
            hwTimer::stop();
            POWERMGNT::setPower(MinPower);
            setWifiUpdateMode();
            Radio.End();
        }

    Faz todo sentido no proposito original -- WiFi ali e MODO DE ATUALIZACAO de
    firmware, e ninguem quer o radio disputando CPU com um upload. Nao serve
    para o nosso, em que o AP e painel de bancada e o enlace precisa continuar.

    O bloco inteiro passa a ser pulado quando apCoexist esta ligado. O que fica
    valendo e so a parte de baixo de startWiFi(), que sobe o AP.

    Custo medido em bancada fica no relatorio: o WiFi do ESP32 e 2,4 GHz, mesma
    banda do enlace, e roda no mesmo core do laco de radio.
    """
    p = SRC / "lib" / "WIFI" / "devWIFI.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: com apCoexist o radio NAO para"
    if marca in text:
        print("-> devWIFI.cpp: startWiFi mantem o radio (ja aplicado)")
        return

    alvo = """  if (connectionState < FAILURE_STATES) {
    hwTimer::stop();"""
    novo = """  // """ + marca + """.
  //
  // Sem esta condicao o AP derruba hwTimer, potencia, connectionState e o
  // proprio Radio -- e ai nao ha enlace nenhum para conviver com o painel.
  if (connectionState < FAILURE_STATES && !apCoexist) {
    hwTimer::stop();"""
    if alvo not in text:
        print("-> devWIFI.cpp: ANCORA DO startWiFi NAO ENCONTRADA")
        return

    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> devWIFI.cpp: startWiFi mantem o radio vivo")


def patch_connection_events() -> None:
    """GotConnection/LostConnection passam a avisar os dispositivos.

    O LED so reavalia o estado dentro de event(), e event() so roda quando
    alguem chama devicesTriggerEvent(). No upstream nenhuma das duas transicoes
    de enlace chama:

        void GotConnection(unsigned long now) {
            connectionState = connected;
            DBGLN("got conn");        // e mais nada
        }

    O LED do upstream sobrevive a isso por acidente: o ramo de "desconectado"
    devolve um flashLED(), e um piscar mantem o timeout() sendo chamado para
    sempre -- o dispositivo continua vivo mesmo sem evento algum.

    A convencao deste projeto nao tem essa sorte: "sem transmissor" e LUZ FIXA,
    e luz fixa devolve DURATION_NEVER. O dispositivo para de ser consultado e o
    LED congela no ultimo estado -- aceso para sempre, mesmo com o enlace
    ativo. Foi exatamente o sintoma relatado na bancada.

    A correcao e avisar na transicao, que e o que o resto do firmware ja faz
    quando muda de modo (ver devicesTriggerEvent() em rx_main). Nao e gambiarra
    para o LED: qualquer dispositivo que dependa do estado do enlace -- buzzer,
    tela, backpack -- estava igualmente cego.
    """
    p = SRC / "src" / "rx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: avisa os dispositivos na transicao de enlace"
    if marca in text:
        print("-> rx_main.cpp: eventos de enlace (ja aplicado)")
        return

    alvos = [
        ('    connectionState = connected; //we got a packet, therefore no lost connection',
         '    connectionState = connected; //we got a packet, therefore no lost connection\n'
         '    // ' + marca + '.\n'
         '    devicesTriggerEvent();'),
        ('    connectionState = disconnected; //set lost connection',
         '    connectionState = disconnected; //set lost connection\n'
         '    // ' + marca + '.\n'
         '    devicesTriggerEvent();'),
    ]

    for alvo, novo in alvos:
        if alvo not in text:
            print("-> rx_main.cpp: ANCORA NAO ENCONTRADA: " + alvo[:44])
            return
        text = text.replace(alvo, novo, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> rx_main.cpp: devicesTriggerEvent nas transicoes de enlace")


def gerar_painel_embutido() -> bool:
    """Embute data/*.html|js|css no binario, comprimidos.

    Nao da para servir do sistema de arquivos: o firmware da bancada grava o
    data/ como LittleFS e o build do ExpressLRS monta SPIFFS -- formatos
    diferentes, e devWIFI.cpp nem enxerga LittleFS. Embutir e o caminho que o
    proprio ExpressLRS ja usa para a pagina dele (ver files[] em
    WebUpdateSendContent), entao nao inventa um mecanismo novo.

    Gzip porque o navegador aceita direto pelo Content-Encoding e o painel tem
    ~70 kB de texto -- comprimido cabe em cerca de 20 kB de flash, contra 58%
    ja ocupados no RX.
    """
    import gzip

    origem = HERE.parent.parent / "data"
    arquivos = [
        ("index.html", "text/html"),
        ("app.js", "application/javascript"),
        ("style.css", "text/css"),
    ]

    partes = [
        "// GERADO por apply_overlay.py -- nao editar a mao.",
        "//",
        "// Conteudo de data/ do projeto da bancada, comprimido. Ver",
        "// gerar_painel_embutido() para o porque de embutir em vez de servir",
        "// do sistema de arquivos.",
        "#pragma once",
        "#include <Arduino.h>",
        "",
    ]

    total = 0
    for nome, _tipo in arquivos:
        caminho = origem / nome
        if not caminho.exists():
            print("-> painel: %s nao encontrado, pulando embutir" % nome)
            return False
        bruto = caminho.read_bytes()
        comp = gzip.compress(bruto, 9)
        total += len(comp)
        simbolo = "painel_" + nome.replace(".", "_")
        linhas = []
        for i in range(0, len(comp), 16):
            linhas.append("  " + ", ".join("0x%02x" % b for b in comp[i:i + 16]) + ",")
        partes.append("// %s: %d bytes -> %d comprimido" % (nome, len(bruto), len(comp)))
        partes.append("static const uint8_t %s[] PROGMEM = {" % simbolo)
        partes.extend(linhas)
        partes.append("};")
        partes.append("static const size_t %s_len = %d;" % (simbolo, len(comp)))
        partes.append("")

    (SRC / "lib" / "WIFI" / "painel_files.h").write_text(
        "\n".join(partes), encoding="utf-8")
    print("-> painel_files.h: %d bytes embutidos" % total)
    return True


def checar_json_do_painel() -> None:
    """O estado do painel tem de ser JSON valido -- conferido na FONTE.

    O painel monta o estado com snprintf encadeado, e ali um campo escrito no
    lugar errado nao da erro de compilacao nem de execucao: gera uma cadeia que
    o navegador rejeita calada. Foi o que aconteceu ao mover as medidas para
    perto do inicio -- elas cairam DENTRO do array "rcAll", que ainda estava
    aberto, e o painel inteiro parou de ler o estado. Os mostradores de manche
    continuaram, porque vem de /api/rc, e isso escondeu o defeito.

    checa_json.py remonta o JSON a partir das strings de formato do molde e
    tenta interpreta-lo. Nao substitui um teste no aparelho, mas pega esta
    classe de erro antes da gravacao -- que e onde ela custa caro.
    """
    import subprocess
    script = HERE / "checa_json.py"
    molde = HERE / "painel_handlers.cpp.in"
    if not script.exists() or not molde.exists():
        print("-> painel: checa_json.py ausente, verificacao pulada")
        return
    r = subprocess.run([sys.executable, str(script), str(molde)],
                       capture_output=True, text=True)
    print("-> " + (r.stdout.strip() or r.stderr.strip()))
    if r.returncode != 0:
        raise SystemExit("estado do painel nao e JSON valido; corrija antes de gravar")


def patch_rx_fixa_banda() -> None:
    """A banda escolhida no painel do receptor PARA de ser sobrescrita.

    Ela era gravada corretamente -- config.SetRateInitialIdx() vai para a NVS --
    e o firmware a apagava logo depois, por dois caminhos:

    1. cycleRfMode() varre TODAS as taxas quando nao ha enlace, e a varredura
       cruza a fronteira das bandas: posto em 433, o receptor achava o
       transmissor em 2,4 GHz e enlacava la.

    2. Ao enlacar, rx_main faz `config.SetRateInitialIdx(nextAirRateIndex)` --
       "use esta taxa como inicial da proxima vez". A escolha do usuario era
       substituida pela taxa em que ele por acaso enlacou.

    O efeito era exatamente o que se ve na bancada: escolhe 433, a placa
    reinicia, e volta em 2,4 GHz. Parece que nao gravou. Gravou; foi desfeito.

    Aqui a varredura passa a respeitar a BANDA da taxa inicial. Continua
    varrendo -- achar o transmissor numa taxa diferente e util -- mas dentro da
    banda escolhida. Como a varredura nao sai da banda, a gravacao do item 2
    tambem nao consegue mais troca-la: ela so pode registrar uma taxa da mesma
    banda.

    Numa bancada de alcance isso e o comportamento certo: pedir 433 e ficar em
    433, mesmo sem enlace, e informacao. Vagar ate achar um transmissor em outra
    banda esconde o fato de que a outra ponta nao foi trocada.
    """
    p = SRC / "src" / "rx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: varredura presa a banda"
    if marca in text:
        print("-> rx_main.cpp: varredura presa a banda (ja aplicado)")
        return

    alvo = """        // Skip unsupported modes for hardware with only a single LR1121 or with a single RF path
        while (!isSupportedRFRate(scanIndex % RATE_MAX))
        {
            DBGLN("Skip %u", get_elrs_airRateConfig(scanIndex % RATE_MAX)->interval);
            scanIndex++;
        }"""
    if alvo not in text:
        print("-> rx_main.cpp: ANCORA DA VARREDURA NAO ENCONTRADA")
        return

    novo = """        // """ + marca + """.
        //
        // Pula tambem o que estiver FORA da banda escolhida no painel. Sem
        // isto a varredura cruzava a fronteira, o receptor enlacava em 2,4 GHz
        // depois de ter sido posto em 433, e a linha
        // `config.SetRateInitialIdx(nextAirRateIndex)` do GotConnection
        // gravava 2,4 GHz por cima da escolha do usuario.
        {
            const uint8_t inicial = config.GetRateInitialIdx();
            const expresslrs_mod_settings_s *mi = get_elrs_airRateConfig(inicial);
            const bool inicial2g4 = mi && mi->radio_type == RADIO_TYPE_LR2021_LORA_2G4;
            uint8_t tentativas = 0;
            while (tentativas++ < RATE_MAX)
            {
                const uint8_t k = scanIndex % RATE_MAX;
                const expresslrs_mod_settings_s *mk = get_elrs_airRateConfig(k);
                const bool k2g4 = mk && mk->radio_type == RADIO_TYPE_LR2021_LORA_2G4;
                if (isSupportedRFRate(k) && k2g4 == inicial2g4)
                    break;
                DBGLN("Skip %u", get_elrs_airRateConfig(k)->interval);
                scanIndex++;
            }
        }"""

    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> rx_main.cpp: varredura nao sai mais da banda escolhida")


def patch_rx_painel() -> None:
    """Serve o painel deste projeto no proprio receptor ExpressLRS.

    Ate aqui havia uma troca chata: ou o receptor rodava o firmware da bancada
    e servia o painel em 192.168.4.1 -- mas, preso no canal de sync, nunca via
    um RCDATA e as barras de manche ficavam vazias --, ou rodava o ExpressLRS de
    verdade, seguia o FHSS e recebia os canais a 50 Hz, mas a pagina que subia
    era a do proprio ExpressLRS, sem mostrador nenhum.

    Nao ha razao para escolher. O ExpressLRS ja tem um servidor web
    (ESPAsyncWebServer) e ja tem os canais decodificados em ChannelData. O que
    faltava era publicar isso: uma rota de estado em JSON e as tres rotas dos
    arquivos do painel.

    O JSON e propositalmente o MESMO formato do /api/state da bancada, para o
    app.js do painel nao precisar saber em qual firmware esta falando.
    """
    if not gerar_painel_embutido():
        return

    p = SRC / "lib" / "WIFI" / "devWIFI.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: painel do projeto"
    ini_m = "// >>> painel_handlers.cpp.in (gerado -- nao editar aqui) >>>"
    fim_m = "// <<< painel_handlers.cpp.in <<<"
    if ini_m in text and fim_m in text:
        molde_p = HERE / "painel_handlers.cpp.in"
        a = text.index(ini_m)
        b = text.index(fim_m) + len(fim_m)
        atual = text[a:b]
        alvo_txt = (ini_m + chr(10) + molde_p.read_text(encoding="utf-8") +
                    chr(10) + fim_m)
        # O registro das rotas vive FORA dos marcadores e nao e trocado pela
        # ressincronizacao. Quando /api/config deixou de ser exclusiva do
        # transmissor, a guarda antiga ficou no arquivo e o receptor seguiu
        # devolvendo 404. Reparo idempotente, toda execucao:
        guarda = ('#if defined(TARGET_TX)' + chr(10) +
                  '  server.on("/api/config", HTTP_POST, HandlePainelConfig);' + chr(10) +
                  '  server.on("/api/config", HTTP_GET, HandlePainelConfig);' + chr(10) +
                  '#endif')
        if guarda in text:
            text = text.replace(guarda, guarda[len('#if defined(TARGET_TX)') + 1:
                                              -len('#endif') - 1], 1)
            p.write_text(text, encoding="utf-8", errors="surrogateescape")
            print("-> devWIFI.cpp: /api/config liberada tambem no receptor")

        if atual == alvo_txt:
            print("-> devWIFI.cpp: painel do projeto (em dia)")
        else:
            text = text[:a] + alvo_txt + text[b:]
            p.write_text(text, encoding="utf-8", errors="surrogateescape")
            print("-> devWIFI.cpp: painel do projeto RESSINCRONIZADO com o molde")
        return
    if marca in text:
        print("-> devWIFI.cpp: painel do projeto (ja aplicado)")
        return

    # --- 1. handler do estado, antes de startServices() -------------------
    ancora_fn = "static void startServices()"
    if ancora_fn not in text:
        print("-> devWIFI.cpp: ANCORA startServices NAO ENCONTRADA")
        return

    # include do header gerado, junto dos outros
    inc = "#include <ESPAsyncWebServer.h>"
    if inc in text and "painel_files.h" not in text:
        text = text.replace(inc, inc + chr(10) + '#include "painel_files.h"', 1)

    # O C dos handlers vive num arquivo .cpp.in, e nao numa string aqui.
    # JSON em C e feito de aspas escapadas, e escapar aspas dentro de uma
    # string de Python que gera C ja quebrou este patch duas vezes.
    molde = HERE / "painel_handlers.cpp.in"
    if not molde.exists():
        print("-> painel: painel_handlers.cpp.in nao encontrado")
        return
    INI = "// >>> painel_handlers.cpp.in (gerado -- nao editar aqui) >>>"
    FIM = "// <<< painel_handlers.cpp.in <<<"
    handler = INI + chr(10) + molde.read_text(encoding="utf-8") + chr(10) + FIM + chr(10) + chr(10)

    text = text.replace(ancora_fn, handler + ancora_fn, 1)

    # --- 2. registra as rotas dentro de startServices() -------------------
    raiz_old = 'server.on("/", WebUpdateHandleRoot);'
    raiz_new = 'server.on("/", HTTP_GET, HandlePainelFile);'
    if raiz_old not in text:
        print("-> devWIFI.cpp: ANCORA DA RAIZ NAO ENCONTRADA")
        return
    text = text.replace(raiz_old, raiz_new, 1)

    ancora_rota = 'server.on("/config", HTTP_GET, GetConfiguration);'
    if ancora_rota not in text:
        print("-> devWIFI.cpp: ANCORA DE ROTA NAO ENCONTRADA")
        return

    rotas = ancora_rota + """

  // """ + marca + """: estado e arquivos.
  // Os arquivos vem do LittleFS, gravado por `pio run -t uploadfs` no projeto
  // da bancada -- os mesmos data/index.html, app.js e style.css, sem copia.
  server.on("/api/state", HTTP_GET, HandlePainelState);
  server.on("/api/rc", HTTP_GET, HandlePainelRc);
  server.on("/api/config", HTTP_POST, HandlePainelConfig);
  server.on("/api/config", HTTP_GET, HandlePainelConfig);
  server.on("/app.js", HTTP_GET, HandlePainelFile);
  server.on("/style.css", HTTP_GET, HandlePainelFile);
  server.on("/index.html", HTTP_GET, HandlePainelFile);
  // A pagina de configuracao do ExpressLRS sai da raiz e vai para /elrs. So
  // pode haver UM app: quem abre o endereco da placa tem de cair no painel,
  // nao ter de escolher entre dois.
  server.on("/elrs", WebUpdateHandleRoot);
"""
    text = text.replace(ancora_rota, rotas, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> devWIFI.cpp: painel do projeto em /painel")


def patch_ap_address() -> None:
    """Endereco do AP: 192.168.4.1, o do projeto -- nao 10.0.0.1 do ExpressLRS.

    Ha UM app, e ele mora no endereco que a equipe ja tem na cabeca desde o
    firmware de bancada. Trocar de endereco junto com o firmware seria pedir
    para alguem descobrir na hora errada, no meio de um teste de campo, que a
    pagina "sumiu".
    """
    p = SRC / "lib" / "OPTIONS" / "options.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    if '"192.168.4.1"' in text:
        print("-> options.cpp: endereco do AP (ja aplicado)")
        return

    alvo = 'const char *wifi_ap_address = "10.0.0.1";'
    if alvo not in text:
        print("-> options.cpp: ANCORA DO ENDERECO NAO ENCONTRADA")
        return

    novo = ("// overlay v3-lr2021: endereco do projeto, nao o do ExpressLRS.\n"
            'const char *wifi_ap_address = "192.168.4.1";')
    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> options.cpp: AP em 192.168.4.1")


def patch_tx_simulador() -> None:
    """Transmissor que vai ao ar SEM handset -- o simulador de bancada.

    Tres coisas travavam isso, e as tres estao aqui:

    1. UARTdisconnected() chama hwTimer::stop(), e e o timer que dispara o
       SendRCdataToRF(). Sem handset o transmissor simplesmente nao transmite.

    2. No boot o timer nunca chega a ser iniciado: quem o liga e
       UARTconnected(), que so roda quando um radio aparece na UART.

    3. ChannelData fica em zero, e zero nao e manche centrado -- e fim de curso.

    O upstream ate preve o caso; o comentario dele em SendRCdataToRF diz "*Do*
    send data if a packet has never been received from handset and the timer is
    running -- this is the case when bench testing and TXing without a
    handset". Faltava garantir o "and the timer is running".

    Isto NAO atrapalha o uso com radio de verdade: assim que CRSF comeca a
    chegar, UARTconnected() assume, connectionState sai de noCrossfire e o
    gerador para de escrever. O handset ganha, sempre.
    """
    p = SRC / "src" / "tx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: transmissor INDEPENDENTE"
    if marca in text:
        print("-> tx_main.cpp: simulador de bancada (ja aplicado)")
        return

    # 1. o timer nao para mais quando nao ha handset
    a1 = """static void UARTdisconnected()
{
  hwTimer::stop();
  connectionState = noCrossfire;
}"""
    n1 = """static void UARTdisconnected()
{
  // overlay v3-lr2021: o hwTimer NAO para -- ver patch_tx_simulador().
  // Parar aqui e o que deixava o transmissor mudo sem handset, porque e o
  // timer que dispara SendRCdataToRF().
  connectionState = noCrossfire;
}"""
    if a1 not in text:
        print("-> tx_main.cpp: ANCORA UARTdisconnected NAO ENCONTRADA")
        return
    text = text.replace(a1, n1, 1)

    # 2. o timer arranca no boot, e nao so quando um radio aparece
    a2 = """      hwTimer::init(nullptr, timerCallback);
      connectionState = noCrossfire;"""
    n2 = """      hwTimer::init(nullptr, timerCallback);
      connectionState = noCrossfire;
      // overlay v3-lr2021: arranca o timer no boot. Sem isto quem o inicia e
      // UARTconnected(), que so roda quando um handset aparece -- e a bancada
      // precisa de um par que va ao ar sozinho.
      hwTimer::resume();"""
    if a2 not in text:
        print("-> tx_main.cpp: ANCORA hwTimer::init NAO ENCONTRADA")
        return
    text = text.replace(a2, n2, 1)

    # 3. gerador de canais no laco principal
    molde = HERE / "tx_simulador.cpp.in"
    if not molde.exists():
        print("-> tx_main.cpp: tx_simulador.cpp.in nao encontrado")
        return

    a3 = """  // Update UI devices
  devicesUpdate(now);"""
    if a3 not in text:
        print("-> tx_main.cpp: ANCORA devicesUpdate NAO ENCONTRADA")
        return
    text = text.replace(a3, molde.read_text(encoding="utf-8") + a3, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> tx_main.cpp: transmissor independente (simulador de bancada)")


def patch_tx_sem_handset() -> None:
    """"Sem handset" vira uma FLAG, e para de sequestrar o connectionState.

    O patch_tx_simulador deixou o transmissor no ar sozinho, mas preso em
    connectionState = noCrossfire. E ai esta o problema, no enum do upstream:

        connected, tentative, awaitingModelId, disconnected,
        MODE_STATES,          // <-- fronteira
        noCrossfire, bleJoystick, ...

    noCrossfire fica ACIMA de MODE_STATES, e o laco principal so roda a maquina
    de conexao abaixo dela:

        if (connectionState < MODE_STATES) { UpdateConnectDisconnectStatus(); }

    Ou seja: o transmissor independente nunca chegava a `connected`, mesmo com
    telemetria chegando e sendo medida. O painel mostrava traco em RSSI, SNR e
    LQ nao porque o canal de volta estivesse mudo -- ele nao estava --, mas
    porque a maquina que reconhece o retorno estava desligada. De quebra o
    intervalo de SYNC ficava no valor de "desconectado" para sempre.

    A causa e ter usado connectionState para dizer duas coisas diferentes: o
    estado do ENLACE e a ausencia de HANDSET. Sao independentes -- da para nao
    ter radio e ter telemetria, que e exatamente esta bancada.

    Entao a ausencia de handset passa a ser uma variavel propria, `semHandset`,
    e connectionState volta a falar so do enlace. O simulador de canais passa a
    olhar a flag, e a maquina de conexao volta a rodar.
    """
    p = SRC / "src" / "tx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: ausencia de handset"
    if marca in text:
        print("-> tx_main.cpp: semHandset (ja aplicado)")
        return

    if "connectionState = noCrossfire;" not in text:
        print("-> tx_main.cpp: ANCORA noCrossfire NAO ENCONTRADA")
        return

    # a flag, declarada junto do resto do estado do modulo
    ancora_var = "static void UARTdisconnected()"
    decl = ("// " + marca + " -- ver patch_tx_sem_handset().\n"
            "// Diz apenas se ha um handset falando CRSF. NAO e estado de enlace:\n"
            "// connectionState continua respondendo por isso, e as duas coisas sao\n"
            "// independentes -- esta bancada transmite sem radio e recebe telemetria.\n"
            "bool semHandset = true;\n\n")
    text = text.replace(ancora_var, decl + ancora_var, 1)

    # noCrossfire deixa de ser o estado do transmissor independente
    text = text.replace("connectionState = noCrossfire;",
                        "semHandset = true;\n  connectionState = disconnected;")

    # e o handset, quando aparece, baixa a flag
    a_conn = "  rfModeLastChangedMS = millis(); // force syncspam on first packets"
    text = text.replace(a_conn, "  semHandset = false;\n" + a_conn, 1)

    # quem perguntava pelo estado agora pergunta pela flag
    text = text.replace("if (connectionState == noCrossfire)", "if (semHandset)")

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> tx_main.cpp: ausencia de handset virou flag; maquina de conexao volta a rodar")


def patch_tx_wifi_core() -> None:
    """WiFi do transmissor no core 1, junto do laco principal.

    O framework de dispositivos do ExpressLRS reparte por nucleo: afinidade 1
    roda dentro de devicesUpdate() no laco principal, afinidade 0 roda numa task
    fixada no core 0. A task do core 0 so destrava com este aperto de mao:

        void devicesInit()  { ... if (core == 1) { xSemaphoreGive(taskSemaphore); ... } }
        static void deviceTask(...) { xSemaphoreTake(taskSemaphore, portMAX_DELAY); ... }

    No receptor isso funciona. No transmissor do S3, nao: medi com um DBGLN
    dentro do bloco que sobe o AP e ele nunca executa -- nem pelo timeout() nem
    pelo event(). Tudo que tem afinidade 0 fica parado la, e o WiFi e um deles.

    Em vez de consertar o aperto de mao do upstream -- que serve a dezenas de
    alvos e nao e nosso -- o WiFi do TX passa para o core 1. E onde o laco
    principal ja roda, nao depende de semaforo nenhum, e o custo e ficar no
    mesmo nucleo do laco de radio.

    Esse custo e aceitavel aqui e nao seria num receptor: o TX gera os proprios
    canais a 50 Hz, com folga de CPU, enquanto o RX tem prazos de recepcao para
    cumprir. Por isso a mudanca e so no tx_main.
    """
    p = SRC / "src" / "tx_main.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: WiFi no core 1"
    if marca in text:
        print("-> tx_main.cpp: WiFi no core 1 (ja aplicado)")
        return

    alvo = """#ifdef HAS_WIFI
  {&WIFI_device, 0},
#endif"""
    novo = """#ifdef HAS_WIFI
  // """ + marca + """: a task do core 0 nao e servida neste
  // alvo, e tudo com afinidade 0 fica parado. Ver patch_tx_wifi_core().
  {&WIFI_device, 1},
#endif"""
    if alvo not in text:
        print("-> tx_main.cpp: ANCORA DA LISTA DE DEVICES NAO ENCONTRADA")
        return

    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> tx_main.cpp: WiFi do TX no core 1")


def patch_dominios() -> None:
    """Banda sub-GHz escolhida em CAMPO, e nao na compilacao.

    Dois problemas, e o segundo esconde o primeiro.

    1. O ExpressLRS fixa o dominio regulatorio por define. Este banco de provas
       precisa comparar 433, 470, 868 e 915 no mesmo dia -- recompilar e
       regravar as duas placas entre medidas nao e um fluxo de trabalho, e
       ainda troca duas variaveis de uma vez (a banda E o binario).

    2. O define nem chegava a valer. Para alvos unificados (ESP), as opcoes vem
       de um JSON gravado no flash, e options.cpp faz:

           firmwareOptions.domain = doc["domain"] | 0;

       O binary_configurator so escreve a chave "domain" quando recebe --domain,
       o que nao existe para ESP. Sem a chave, o `| 0` vence: AU915, sempre,
       qualquer que fosse o -DRegulatory_Domain_* da compilacao. Era por isso
       que o painel anunciava 915 MHz depois de compilarmos com EU_433.

    A correcao ataca a causa: o dominio vira estado, ajustavel pelo painel e
    gravado com saveOptions(). FHSSrandomiseFHSSsequence() ja rele
    firmwareOptions.domain a cada chamada, entao trocar e reconstruir a
    sequencia basta -- nao ha estado derivado sobrando.

    Acrescenta tambem CN470, que a tabela do upstream nao tem e o modulo faz.
    Nao acrescenta a faixa de 150 MHz: o modulo a suporta, mas ali nao existe
    alocacao ISM em lugar nenhum -- e VHF licenciado. Um clique nao deve ser
    tudo que separa uma bancada de transmitir em faixa de servico movel.
    """
    p = SRC / "lib" / "FHSS" / "FHSS.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: CN470"
    if marca in text:
        print("-> FHSS.cpp: dominios (ja aplicado)")
        return

    alvo = '    {"US433W",  FREQ_HZ_TO_REG_VAL(423500000), FREQ_HZ_TO_REG_VAL(438000000), 20, 434000000},'
    if alvo not in text:
        print("-> FHSS.cpp: ANCORA US433W NAO ENCONTRADA")
        return

    novo = (alvo + chr(10) +
            "    // " + marca + ": o modulo LoRa2021 tem variante de 470 MHz e o" + chr(10) +
            "    // upstream nao traz o plano. Vai no FIM da lista de proposito -- os" + chr(10) +
            "    // indices 0..7 sao os que o binary_configurator escreve por nome." + chr(10) +
            '    {"CN470",  FREQ_HZ_TO_REG_VAL(470000000), FREQ_HZ_TO_REG_VAL(510000000), 8, 490000000},')
    text = text.replace(alvo, novo, 1)

    # quantos dominios existem, para quem for validar uma escolha
    alvo2 = "// Our table of FHSS frequencies."
    if alvo2 in text and "FHSSdomainCount" not in text:
        novo2 = ("uint8_t FHSSdomainCount() { return sizeof(domains) / sizeof(domains[0]); }" + chr(10) +
                 "const fhss_config_t *FHSSdomainAt(uint8_t i) { return &domains[i]; }" + chr(10) + chr(10) +
                 alvo2)
        text = text.replace(alvo2, novo2, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")

    h = SRC / "lib" / "FHSS" / "FHSS.h"
    ht = h.read_text(encoding="utf-8", errors="surrogateescape")
    if "FHSSdomainCount" not in ht:
        alvo_h = "void FHSSrandomiseFHSSsequence(uint32_t seed);"
        if alvo_h not in ht:
            print("-> FHSS.h: ANCORA NAO ENCONTRADA")
            return
        novo_h = ("// " + marca + ": a lista de dominios, para o painel oferecer a escolha." + chr(10) +
                  "uint8_t FHSSdomainCount();" + chr(10) +
                  "const fhss_config_t *FHSSdomainAt(uint8_t i);" + chr(10) +
                  alvo_h)
        h.write_text(ht.replace(alvo_h, novo_h, 1), encoding="utf-8", errors="surrogateescape")

    print("-> FHSS.cpp: CN470 e acessores de dominio")


def patch_default_tlm() -> None:
    """Telemetria ligada de fabrica, com razao explicita.

    De fabrica o `tlm` do transmissor fica em TLM_RATIO_STD, que e o zero do
    memset de SetDefaults(). STD nao quer dizer "desligada" -- quer dizer "use a
    sugerida pela taxa", e na taxa de fabrica deste projeto (LORA_50HZ em
    2,4 GHz) a tabela sugere 1:16. Ou seja: ja funcionava.

    O problema de STD e depender da taxa. Trocar para 500 Hz no painel levaria a
    telemetria junto para 1:128 sem ninguem pedir, e o painel do transmissor
    passaria quase dez segundos entre leituras de RSSI. Numa bancada de alcance,
    onde o numero na tela E o experimento, esse acoplamento silencioso e ruim.

    Entao a fabrica passa a nomear a razao: 1:16 vale para qualquer taxa, custa
    pouco ar e devolve leitura rapido o bastante para acompanhar a caminhada.
    Quem quiser outra escolhe no painel -- inclusive "Padrao da taxa" de volta.

    Nao mexe em placa ja configurada: SetDefaults() so roda com NVS virgem ou
    apos reset de fabrica. E de proposito -- a taxa e a potencia escolhidas pelo
    usuario nao devem sumir por causa de uma gravacao.
    """
    p = SRC / "lib" / "CONFIG" / "config.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: telemetria de fabrica"
    if marca in text:
        print("-> config.cpp: telemetria de fabrica (ja aplicado)")
        return

    alvo = "        SetPower(POWERMGNT::getDefaultPower());"
    if alvo not in text:
        print("-> config.cpp: ANCORA SetPower NAO ENCONTRADA")
        return

    novo = (alvo + chr(10) +
            "        // " + marca + " -- ver patch_default_tlm()." + chr(10) +
            "        // Razao nomeada em vez de TLM_RATIO_STD, que seguiria a taxa e" + chr(10) +
            "        // rarearia a leitura de RSSI sozinha ao subir para 500 Hz." + chr(10) +
            "        SetTlm(TLM_RATIO_1_128);")

    text = text.replace(alvo, novo, 1)
    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> config.cpp: telemetria de fabrica em 1:16")


def patch_uart_com_ap() -> None:
    """USART parada enquanto o AP do painel estiver no ar.

    O upstream ja tem essa regra -- so nao a aplica ao nosso modo:

        // do not adjust the parameters while in wifi mode. If a firmware is
        // being uploaded, it will cause tons of serial errors during the flash
        // writes
        if ((connectionState != wifiUpdate) && (...))

    A intencao e clara: com WiFi ativo, a UART vira fonte de ruido e o watchdog
    fica ciclando baud atras de um handset que nao existe. Mas a condicao olha
    para connectionState == wifiUpdate, e o AP deste projeto NAO usa esse estado
    -- e justamente o que permite o radio continuar no ar. Entao o watchdog
    seguia rodando, enchendo o log e trocando de baud a cada segundo.

    Aqui a mesma regra passa a valer para o AP do painel. Nao e desligar a UART:
    quadros CRSF que chegarem continuam sendo lidos normalmente. O que para e a
    autobaud -- a busca ciclica que so faz sentido quando ha um radio a procurar.

    Efeito colateral desejado: com o painel aberto, um handset ligado depois
    continua sendo reconhecido se falar no baud corrente.
    """
    p = SRC / "lib" / "HANDSET" / "CRSFHandset.cpp"
    text = p.read_text(encoding="utf-8", errors="surrogateescape")

    marca = "overlay v3-lr2021: autobaud parada com o AP no ar"
    if marca in text:
        print("-> CRSFHandset.cpp: autobaud com AP (ja aplicado)")
        return

    alvo = "        if ((connectionState != wifiUpdate) && (BadPktsCount >= GoodPktsCount || !controllerConnected))"
    novo = ("        // " + marca + ".\n"
            "        // Mesma intencao da condicao original, estendida ao AP deste\n"
            "        // projeto, que nao passa por connectionState = wifiUpdate.\n"
            "        if ((connectionState != wifiUpdate) && !painelApAtivo() &&\n"
            "            (BadPktsCount >= GoodPktsCount || !controllerConnected))")

    if alvo not in text:
        print("-> CRSFHandset.cpp: ANCORA DO WDT NAO ENCONTRADA")
        return
    text = text.replace(alvo, novo, 1)

    # Declaracao local em vez de incluir devWIFI.h: aquele header puxa
    # device.h -> crc.h, que nao resolve a partir deste diretorio de include.
    decl = "bool CRSFHandset::UARTwdt()"
    if decl in text and "extern bool painelApAtivo" not in text:
        text = text.replace(decl, "extern bool painelApAtivo();" + chr(10) +
                            chr(10) + decl, 1)

    p.write_text(text, encoding="utf-8", errors="surrogateescape")
    print("-> CRSFHandset.cpp: autobaud parada com o AP no ar")

    # --- o acessor, do lado do WiFi -------------------------------------
    h = SRC / "lib" / "WIFI" / "devWIFI.h"
    ht = h.read_text(encoding="utf-8", errors="surrogateescape")
    if "painelApAtivo" not in ht:
        alvo_h = "extern device_t WIFI_device;"
        novo_h = (alvo_h + chr(10) + chr(10) +
                  "// true quando o AP do painel esta no ar. Existe para quem precisa se\n"
                  "// comportar diferente com WiFi ativo sem depender de connectionState --\n"
                  "// que neste projeto continua refletindo o ENLACE, e nao o WiFi.\n"
                  "bool painelApAtivo();")
        if alvo_h not in ht:
            print("-> devWIFI.h: ANCORA NAO ENCONTRADA")
            return
        h.write_text(ht.replace(alvo_h, novo_h, 1), encoding="utf-8",
                     errors="surrogateescape")

    c = SRC / "lib" / "WIFI" / "devWIFI.cpp"
    ct = c.read_text(encoding="utf-8", errors="surrogateescape")
    if "bool painelApAtivo()" not in ct:
        alvo_c = "static bool force_update = false;"
        novo_c = ("bool painelApAtivo() { return apCoexist && wifiStarted; }" + chr(10) +
                  chr(10) + alvo_c)
        if alvo_c not in ct:
            print("-> devWIFI.cpp: ANCORA DO ACESSOR NAO ENCONTRADA")
            return
        c.write_text(ct.replace(alvo_c, novo_c, 1), encoding="utf-8",
                     errors="surrogateescape")
    print("-> devWIFI: acessor painelApAtivo()")


def main() -> None:
    ensure_clone()
    copy_driver()
    broaden_guards()
    patch_common_h()
    patch_common_cpp()
    patch_driver_includes()
    patch_default_rate()
    patch_tx_simulador()
    patch_tx_sem_handset()
    patch_tx_wifi_core()
    patch_dominios()
    patch_default_tlm()
    patch_uart_com_ap()
    patch_rx_led()
    patch_connection_events()
    patch_rx_wifi()
    patch_wifi_keep_radio()
    patch_rx_fixa_banda()
    patch_rx_painel()
    checar_json_do_painel()
    patch_ap_address()
    patch_rate_band_lock()
    patch_hardware_fields()
    install_hardware()
    install_user_defines()
    patch_targets_ini()
    patch_build_html()
    patch_unified_ini()
    patch_s3_serial()
    print(f"\npronto. compile com:\n  cd \"{SRC}\"\n  pio run -e LoRa2021_TX")


if __name__ == "__main__":
    main()
