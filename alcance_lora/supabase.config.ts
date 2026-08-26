import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/**
 * Falso quando .env.local não tem as credenciais. Os services checam isso para
 * dar uma mensagem clara na tela em vez de um "Failed to fetch" genérico.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const SUPABASE_CONFIG_ERROR =
  'Nuvem não configurada. O app grava tudo localmente mesmo assim; defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY em .env.local para sincronizar.';

// Aviso, não erro: aqui a nuvem é opcional. A gravação primária é IndexedDB no
// aparelho, porque uma campanha de alcance acontece longe de rede.
if (!isSupabaseConfigured) {
  console.info(`[supabase.config] ${SUPABASE_CONFIG_ERROR}`);
}

// URL placeholder só para o createClient não estourar no import e derrubar o app
// inteiro; toda chamada é barrada antes por isSupabaseConfigured.
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.invalid',
  supabaseAnonKey || 'placeholder',
  {
    auth: {
      persistSession: false,
    },
  }
);
