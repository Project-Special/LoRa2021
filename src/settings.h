#pragma once

// Namespace único da NVS deste firmware.
//
// Tudo que sobrevive a um reset mora aqui: a rede de casamento sub-GHz, a
// tensão do TCXO e o par de teste. São três módulos escrevendo no mesmo
// namespace, então a constante vive num lugar só.
namespace settings {

inline constexpr char kNamespace[] = "lora2021";

// Garante que o namespace exista. Chamar UMA vez no setup(), antes de qualquer
// leitura.
void begin();

}  // namespace settings
