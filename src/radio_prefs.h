#pragma once

#include <Arduino.h>

#include "LoraLink.h"

// Ajuste de rádio feito no painel, gravado na placa.
//
// O par de teste (`peer`) traz uma banda e uma modulação prontas, e é o ponto
// de partida. O que este módulo guarda é o que o usuário mexeu DEPOIS — banda,
// frequência, largura, SF, CR e potência — para que a escolha sobreviva ao
// reset.
//
// Antes isso não existia: a banda vinha de um build flag, e trocar de faixa
// exigia recompilar e regravar as duas placas. Pior, mexer no painel funcionava
// até o próximo boot e então voltava sozinho ao valor do define, sem avisar —
// o operador via 433 na tela e o rádio estava em 2,4 GHz.
//
// Regra única, para não haver dois lugares mandando na mesma coisa:
//
//   escolher um PAR apaga o ajuste manual (o par traz a sua própria banda);
//   mexer em qualquer campo de rádio grava o ajuste por cima do par.
//
// Ou seja: o último que foi tocado é o que vale, e ele sobrevive ao reset.
namespace radioprefs {

// Lê o que estiver gravado. Chamar UMA vez no setup, antes de aplicar o par.
void begin();

// true = há ajuste manual gravado, e ele sobrepõe a banda do par.
bool any();

// Aplica o ajuste gravado por cima do que o par acabou de configurar.
// Sem ajuste gravado, não faz nada.
void apply(LoraLink& radio);

// Fotografa o estado atual do rádio e grava. É chamado depois de QUALQUER
// mudança de rádio vinda do painel ou do console.
void save(const LoraLink::State& s);

// Apaga o ajuste, devolvendo o comando ao par. Chamado ao trocar de par.
void clear();

void print(Stream& out);

}  // namespace radioprefs
