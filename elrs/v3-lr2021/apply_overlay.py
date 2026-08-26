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


def main() -> None:
    ensure_clone()
    copy_driver()
    broaden_guards()
    patch_common_h()
    patch_common_cpp()
    patch_driver_includes()
    patch_default_rate()
    patch_rate_band_lock()
    patch_hardware_fields()
    install_hardware()
    install_user_defines()
    patch_targets_ini()
    patch_build_html()
    patch_unified_ini()
    print(f"\npronto. compile com:\n  cd \"{SRC}\"\n  pio run -e LoRa2021_TX")


if __name__ == "__main__":
    main()
