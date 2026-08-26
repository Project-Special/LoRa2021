-- Permite ao app e ao painel apagar campanhas.
--
-- Rode no SQL Editor do Supabase. Sem isto o DELETE devolve HTTP 200 com zero
-- linhas e nenhum erro — o app pareceria ter apagado sem ter apagado.
--
-- ATENCAO: libera DELETE para QUALQUER portador da anon key, que viaja dentro
-- do APK e do painel local. ON DELETE CASCADE leva as amostras junto.

DROP POLICY IF EXISTS "apagar campanhas" ON range_sessions;
CREATE POLICY "apagar campanhas" ON range_sessions FOR DELETE USING (true);

DROP POLICY IF EXISTS "apagar amostras" ON range_samples;
CREATE POLICY "apagar amostras" ON range_samples FOR DELETE USING (true);
