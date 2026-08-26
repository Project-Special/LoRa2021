import { supabase, isSupabaseConfigured, SUPABASE_CONFIG_ERROR } from '../supabase.config';
import { RangeSample, Session } from '../types';
import { SessionStore } from './SessionStore';
import { Diag } from './Diag';

/**
 * Envio das campanhas para o Supabase.
 *
 * A nuvem é o segundo destino, nunca o primeiro: quem grava é o IndexedDB no
 * aparelho, e o envio acontece quando houver rede. Uma campanha de alcance
 * acontece longe de cobertura, então falhar aqui não pode custar a coleta.
 *
 * O envio é INCREMENTAL, e o `local_id` é a chave.
 *
 * Antes era "tudo ou nada, uma vez só": se a campanha já existisse na nuvem, a
 * função devolvia "Já estava na nuvem" e não mandava nada. Parecia sucesso e
 * não era — apertar o botão cedo demais congelava lá uma versão incompleta que
 * o app nunca mais corrigia. Aconteceu de verdade: uma campanha subiu com 1
 * ponto, 9 s depois de criada, e os outros 30 nunca chegaram.
 *
 * Agora reenviar durante a campanha é operação normal: o cabeçalho é
 * atualizado (banda e origem costumam ser definidas DEPOIS do primeiro envio) e
 * das amostras vão só as que ainda não estão lá.
 */

/** Amostras vão em blocos; um POST com 4000 linhas estoura o limite da API. */
const CHUNK = 500;

/** Resumo de uma campanha que está na nuvem, para listar sem baixar os pontos. */
export interface CloudSummary {
  /** UUID remoto — é por ele que se baixa. */
  id: string;
  /** id do aparelho que a criou. Serve para saber se já existe uma cópia local. */
  localId: string;
  name: string;
  createdAt: number;
  band: string | null;
  samples: number;
  maxDistance: number | null;
  bestRssi: number | null;
  worstRssi: number | null;
}

/** Página de amostras. O PostgREST devolve no máximo 1000 linhas por vez. */
const PAGE = 1000;

export interface SyncResult {
  ok: boolean;
  message: string;
  sent?: number;
}

export const CloudSync = {
  isConfigured: () => isSupabaseConfigured,

  async upload(session: Session): Promise<SyncResult> {
    if (!isSupabaseConfigured) {
      return { ok: false, message: SUPABASE_CONFIG_ERROR };
    }

    const header = {
      local_id: session.id,
      name: session.name,
      created_at: new Date(session.createdAt).toISOString(),
      band: session.band,
      freq_mhz: session.freqMHz,
      power_dbm: session.powerDbm,
      origin_lat: session.origin?.latitude ?? null,
      origin_lon: session.origin?.longitude ?? null,
      origin_alt: session.origin?.altitude ?? null,
      origin_source: session.origin?.source ?? null,
      uploaded_at: new Date().toISOString(),
    };

    const { data: existing, error: findErr } = await supabase
      .from('range_sessions')
      .select('id')
      .eq('local_id', session.id)
      .maybeSingle();

    if (findErr) return { ok: false, message: `Consulta falhou: ${findErr.message}` };

    let sessionId: string;
    if (existing) {
      // Atualiza o cabeçalho: no primeiro envio a placa podia estar muda, e
      // banda, potência e origem subiram nulas. Reenviar tem de consertar isso.
      sessionId = existing.id;
      const { error } = await supabase
        .from('range_sessions')
        .update(header)
        .eq('id', sessionId);
      if (error) return { ok: false, message: `Atualização falhou: ${error.message}` };
    } else {
      const { data: created, error: insErr } = await supabase
        .from('range_sessions')
        .insert(header)
        .select('id')
        .single();
      if (insErr || !created) {
        return { ok: false, message: `Envio falhou: ${insErr?.message ?? 'sem id'}` };
      }
      sessionId = created.id;
    }

    // De onde continuar: o instante da última amostra que já está na nuvem.
    //
    // Um único SELECT, em vez de baixar o que existe lá. Contar linhas e cortar
    // por índice seria mais simples e erraria feio se alguma linha tivesse sido
    // apagada no dashboard — mandaria de novo o começo e deixaria o fim de
    // fora. O tempo é o que ordena a campanha, então é ele que decide o corte.
    const { data: last, error: lastErr } = await supabase
      .from('range_samples')
      .select('t')
      .eq('session_id', sessionId)
      .order('t', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastErr) return { ok: false, message: `Consulta de amostras falhou: ${lastErr.message}` };

    const cutoff = last ? new Date(last.t).getTime() : -Infinity;
    const pending = session.samples.filter((p) => p.t > cutoff);

    if (!pending.length) {
      return {
        ok: true,
        message: session.samples.length
          ? `Nada novo — os ${session.samples.length} pontos já estão na nuvem.`
          : 'Campanha sem pontos ainda.',
        sent: 0,
      };
    }

    const rows = pending.map((p) => ({
      session_id: sessionId,
      t: new Date(p.t).toISOString(),
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: p.altitude,
      accuracy_m: p.accuracy,
      distance_m: p.distance,
      rssi_dbm: p.rssi,
      snr_db: p.snr,
      lq: p.lq,
      linked: p.linked,
    }));

    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('range_samples').insert(rows.slice(i, i + CHUNK));
      if (error) {
        return {
          ok: false,
          // Os que já entraram ficam: o próximo envio recomeça daqui, não do
          // zero, porque o corte é pelo tempo da última linha gravada.
          message: `Parou em ${i} de ${rows.length}: ${error.message}`,
          sent: i,
        };
      }
    }

    return {
      ok: true,
      message: `Enviados ${rows.length} pontos novos (${session.samples.length} no total).`,
      sent: rows.length,
    };
  },

  /**
   * Campanhas que existem na nuvem, de QUALQUER aparelho.
   *
   * É o que dá sentido a ter um banco central: o trajeto medido com outro
   * celular, ou com este mesmo antes de alguém apagar a campanha local, volta
   * a ser visível no mapa. Sem isto o app só enxergava o próprio IndexedDB, e
   * o Supabase era um depósito de onde nada saía.
   */
  async listRemote(): Promise<CloudSummary[]> {
    if (!isSupabaseConfigured) return [];
    const { data, error } = await supabase
      .from('range_session_summary')
      .select('id,local_id,name,created_at,band,samples,max_distance_m,best_rssi_dbm,worst_rssi_dbm')
      .order('created_at', { ascending: false });

    if (error || !data) {
      Diag.error(`nuvem: lista falhou — ${error?.message ?? 'sem dados'}`);
      return [];
    }

    return data.map((r) => ({
      id: r.id as string,
      localId: (r.local_id as string) ?? '',
      name: (r.name as string) ?? 'sem nome',
      createdAt: new Date(r.created_at as string).getTime(),
      band: (r.band as string) || null,
      samples: Number(r.samples ?? 0),
      maxDistance: r.max_distance_m == null ? null : Number(r.max_distance_m),
      bestRssi: r.best_rssi_dbm == null ? null : Number(r.best_rssi_dbm),
      worstRssi: r.worst_rssi_dbm == null ? null : Number(r.worst_rssi_dbm),
    }));
  },

  /**
   * Baixa uma campanha inteira da nuvem, pronta para o mapa.
   *
   * As amostras vêm paginadas: uma campanha de uma hora a 1 ponto/s passa de
   * 3000 linhas, e o PostgREST corta em 1000 sem avisar — o trajeto apareceria
   * truncado no mapa e ninguém desconfiaria, porque um pedaço de caminhada
   * ainda parece uma caminhada.
   */
  async download(remoteId: string): Promise<Session | null> {
    if (!isSupabaseConfigured) return null;

    const { data: head, error: headErr } = await supabase
      .from('range_sessions')
      .select('local_id,name,created_at,band,freq_mhz,power_dbm,origin_lat,origin_lon,origin_alt,origin_source')
      .eq('id', remoteId)
      .single();

    if (headErr || !head) {
      Diag.error(`nuvem: campanha nao encontrada — ${headErr?.message ?? ''}`);
      return null;
    }

    const samples: RangeSample[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('range_samples')
        .select('t,latitude,longitude,altitude,accuracy_m,distance_m,rssi_dbm,snr_db,lq,linked')
        .eq('session_id', remoteId)
        .order('t', { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) {
        Diag.error(`nuvem: amostras falharam em ${from} — ${error.message}`);
        return null;
      }
      if (!data?.length) break;

      for (const r of data) {
        samples.push({
          t: new Date(r.t as string).getTime(),
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
          altitude: r.altitude == null ? null : Number(r.altitude),
          accuracy: r.accuracy_m == null ? null : Number(r.accuracy_m),
          distance: r.distance_m == null ? null : Number(r.distance_m),
          rssi: r.rssi_dbm == null ? null : Number(r.rssi_dbm),
          snr: r.snr_db == null ? null : Number(r.snr_db),
          lq: r.lq == null ? null : Number(r.lq),
          linked: Boolean(r.linked),
        });
      }
      if (data.length < PAGE) break;
    }

    return {
      id: (head.local_id as string) || remoteId,
      name: (head.name as string) ?? 'sem nome',
      createdAt: new Date(head.created_at as string).getTime(),
      band: (head.band as string) || null,
      freqMHz: head.freq_mhz == null ? null : Number(head.freq_mhz),
      powerDbm: head.power_dbm == null ? null : Number(head.power_dbm),
      origin:
        head.origin_lat == null || head.origin_lon == null
          ? null
          : {
              latitude: Number(head.origin_lat),
              longitude: Number(head.origin_lon),
              altitude: head.origin_alt == null ? null : Number(head.origin_alt),
              source: (head.origin_source as 'gps' | 'manual') ?? 'manual',
            },
      samples,
    };
  },

  /**
   * Apaga uma campanha da nuvem, com as amostras junto (ON DELETE CASCADE).
   *
   * CONFERE O QUE FOI APAGADO em vez de confiar no status HTTP. Sem a política
   * de DELETE no banco, o PostgREST responde 200 com zero linhas e nenhum erro
   * — o app diria "apagado" e nada teria acontecido. É a mesma classe de falha
   * silenciosa do envio que se declarava idempotente: parecer sucesso é pior
   * que falhar.
   */
  async deleteRemote(remoteId: string): Promise<SyncResult> {
    if (!isSupabaseConfigured) return { ok: false, message: SUPABASE_CONFIG_ERROR };

    const { data, error } = await supabase
      .from('range_sessions')
      .delete()
      .eq('id', remoteId)
      .select('id');

    if (error) return { ok: false, message: `Falha ao apagar: ${error.message}` };

    if (!data?.length) {
      return {
        ok: false,
        message:
          'Nada foi apagado — o banco não permite DELETE. Rode migration-delete.sql no SQL Editor do Supabase.',
      };
    }

    Diag.info('campanha apagada da nuvem');
    return { ok: true, message: 'Campanha apagada da nuvem.' };
  },

  /**
   * Empurra TODAS as campanhas do aparelho, não só a que está aberta.
   *
   * É o que fecha o buraco de verdade: uma campanha que ficou incompleta na
   * nuvem — porque o envio antigo só funcionava uma vez, ou porque a rede caiu
   * no meio — nunca mais era tocada, e ninguém tinha como perceber. Rodando
   * sobre a lista inteira, qualquer ponto que exista no aparelho e não na nuvem
   * sobe na próxima oportunidade, sem o usuário ter de lembrar de nada.
   *
   * Barato porque `upload` é incremental: campanha já sincronizada custa dois
   * SELECTs e nenhuma escrita.
   */
  async syncAll(): Promise<SyncResult> {
    if (!isSupabaseConfigured) return { ok: false, message: SUPABASE_CONFIG_ERROR };

    const list = await SessionStore.list();
    let sent = 0;
    let failed = 0;
    let lastError = '';

    for (const item of list) {
      // Campanha vazia não tem o que sincronizar, e criar a linha na nuvem
      // antes de haver ponto foi justamente o que gerou a "Teste 1" órfã.
      if (!item.samples) continue;
      const full = await SessionStore.get(item.id);
      if (!full) continue;
      const r = await this.upload(full);
      if (r.ok) {
        sent += r.sent ?? 0;
        // Diz quantos pontos existem de cada lado. É o par de números que
        // responde "a nuvem está completa?" sem precisar abrir o dashboard —
        // e foi a falta dele que deixou uma campanha com 1 de 31 passar
        // despercebida por horas.
        if (r.sent) Diag.info(`${item.name}: +${r.sent} de ${item.samples}`);
      } else {
        failed++;
        lastError = r.message;
        Diag.error(`${item.name}: ${r.message}`);
      }
    }

    if (failed) {
      return { ok: false, message: `${failed} campanha(s) falharam: ${lastError}`, sent };
    }
    return {
      ok: true,
      message: sent ? `${sent} ponto(s) enviados.` : 'Tudo já estava na nuvem.',
      sent,
    };
  },
};
