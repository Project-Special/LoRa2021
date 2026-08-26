-- Banco das campanhas de alcance LoRa.
--
-- Execute no SQL Editor do Supabase. Depois preencha .env.local com a URL e a
-- anon key do projeto (Project Settings -> API).
--
-- MODELO
--
-- Duas tabelas, não uma. A campanha tem metadados que não se repetem por ponto
-- (banda, potência, onde estava o transmissor); guardá-los em cada amostra
-- multiplicaria isso por milhares de linhas e, pior, permitiria que duas
-- amostras da mesma campanha discordassem sobre a origem.
--
-- O app funciona INTEIRO sem este banco: a gravação primária é IndexedDB no
-- aparelho. Isto aqui é para consolidar campanhas de vários aparelhos e
-- comparar bandas depois. Um teste de alcance acontece no meio do mato, e
-- depender de rede para não perder a coleta seria um erro de projeto.

CREATE TABLE IF NOT EXISTS range_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- id gerado no aparelho. Permite reenviar sem duplicar depois de uma queda
  -- de rede no meio do envio.
  local_id      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  device_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL,

  -- Configuração do rádio durante a campanha. Sem isto, comparar duas
  -- campanhas é comparar números sem saber o que mudou entre elas.
  band          TEXT,
  freq_mhz      DOUBLE PRECISION,
  power_dbm     INTEGER,
  sf            INTEGER,
  bw_khz        DOUBLE PRECISION,

  -- Onde o transmissor ficou parado. É a referência de toda distância.
  origin_lat    DOUBLE PRECISION,
  origin_lon    DOUBLE PRECISION,
  origin_alt    DOUBLE PRECISION,
  origin_source TEXT CHECK (origin_source IN ('gps', 'manual')),

  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS range_samples (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES range_sessions(id) ON DELETE CASCADE,
  t           TIMESTAMPTZ NOT NULL,

  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  altitude    DOUBLE PRECISION,
  accuracy_m  DOUBLE PRECISION,

  -- Distância até a origem, gravada junto com a amostra.
  --
  -- Poderia ser calculada na consulta a partir de origin_lat/lon. Não é, de
  -- propósito: a origem pode ser corrigida depois, e recalcular faria o
  -- histórico exibir distâncias que nunca foram medidas em campo.
  distance_m  DOUBLE PRECISION,

  rssi_dbm    DOUBLE PRECISION,
  snr_db      DOUBLE PRECISION,
  lq          INTEGER,
  linked      BOOLEAN NOT NULL DEFAULT FALSE
);

-- As consultas do app são sempre "amostras desta campanha, em ordem de tempo".
CREATE INDEX IF NOT EXISTS idx_range_samples_session
  ON range_samples(session_id, t);

-- Para o gráfico RSSI x distância, que varre por distância dentro da campanha.
CREATE INDEX IF NOT EXISTS idx_range_samples_distance
  ON range_samples(session_id, distance_m);

CREATE INDEX IF NOT EXISTS idx_range_sessions_created
  ON range_sessions(created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
--
-- ATENÇÃO, mesma ressalva do projeto gps_rastreador: o app usa a anon key SEM
-- autenticação. As policies abaixo liberam leitura e inserção para anônimos —
-- quem tiver a anon key lê tudo. Serve para bancada e para uma equipe pequena;
-- em produção, exija auth e filtre por auth.uid().
--
-- DELETE: liberado a pedido, para o app e o painel poderem remover campanhas.
--
-- LEIA ANTES DE RODAR. Isto dá a QUALQUER portador da anon key o poder de
-- apagar qualquer campanha, e a chave viaja dentro do APK e do painel local.
-- Não há como um cliente com a anon key provar quem é. O ON DELETE CASCADE de
-- range_samples significa que apagar uma linha aqui leva todas as amostras
-- junto, sem confirmação do lado do banco.
--
-- Para bancada e equipe pequena é aceitável, e é o mesmo compromisso já feito
-- para SELECT e INSERT. Em produção, exija auth e filtre por auth.uid().
-- ---------------------------------------------------------------------------
ALTER TABLE range_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_samples  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ler campanhas" ON range_sessions;
CREATE POLICY "ler campanhas" ON range_sessions FOR SELECT USING (true);

DROP POLICY IF EXISTS "inserir campanhas" ON range_sessions;
CREATE POLICY "inserir campanhas" ON range_sessions FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "ler amostras" ON range_samples;
CREATE POLICY "ler amostras" ON range_samples FOR SELECT USING (true);

DROP POLICY IF EXISTS "inserir amostras" ON range_samples;
CREATE POLICY "inserir amostras" ON range_samples FOR INSERT WITH CHECK (true);

-- Sem estas duas, o DELETE do PostgREST devolve HTTP 200 com zero linhas
-- afetadas e NENHUM erro. O app mostraria "apagado" e nada teria acontecido —
-- por isso o cliente confere quantas linhas voltaram em vez de confiar no 200.
DROP POLICY IF EXISTS "apagar campanhas" ON range_sessions;
CREATE POLICY "apagar campanhas" ON range_sessions FOR DELETE USING (true);

DROP POLICY IF EXISTS "apagar amostras" ON range_samples;
CREATE POLICY "apagar amostras" ON range_samples FOR DELETE USING (true);

-- ---------------------------------------------------------------------------
-- Visão de resumo: o que a tela "Abrir" precisa sem baixar as amostras.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW range_session_summary AS
SELECT
  s.id,
  s.local_id,
  s.name,
  s.created_at,
  s.band,
  s.freq_mhz,
  s.power_dbm,
  COUNT(p.id)                       AS samples,
  MAX(p.distance_m)                 AS max_distance_m,
  MAX(p.rssi_dbm)                   AS best_rssi_dbm,
  MIN(p.rssi_dbm)                   AS worst_rssi_dbm,
  -- Alcance útil: a maior distância em que AINDA havia enlace. É o número que
  -- responde "até onde foi", e nao coincide com max_distance_m quando o
  -- operador continuou andando depois de perder o sinal.
  MAX(p.distance_m) FILTER (WHERE p.linked) AS linked_distance_m
FROM range_sessions s
LEFT JOIN range_samples p ON p.session_id = s.id
GROUP BY s.id;
