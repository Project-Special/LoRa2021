import { RangeSample, Session, SessionSummary } from '../types';

/**
 * Banco local de campanhas de alcance.
 *
 * IndexedDB, não localStorage: uma campanha de uma hora a 1 amostra/s são ~3600
 * pontos, e várias delas passam com folga do limite de ~5 MB do localStorage —
 * que estoura de forma silenciosa, perdendo justamente a sessão mais longa.
 *
 * O índice de resumos é mantido separado das amostras para a tela de abrir
 * listar rápido sem carregar tudo na memória.
 */

const DB_NAME = 'lora-alcance';
const DB_VERSION = 1;
const STORE = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

function summarize(s: Session): SessionSummary {
  // Number.isFinite, e não `!= null`: NaN passa por `!= null` e faz Math.max
  // devolver NaN, que foi exatamente o "RSSI NaN a NaN" na tela de abrir. A
  // origem já foi corrigida no parser, mas as campanhas gravadas antes disso
  // continuam no aparelho — e o resumo não pode quebrar por causa delas.
  const withRssi = s.samples.filter((x) => Number.isFinite(x.rssi as number));
  const dists = s.samples.map((x) => x.distance).filter((d): d is number => d != null);
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    band: s.band,
    samples: s.samples.length,
    maxDistance: dists.length ? Math.max(...dists) : null,
    bestRssi: withRssi.length ? Math.max(...withRssi.map((x) => x.rssi as number)) : null,
    worstRssi: withRssi.length ? Math.min(...withRssi.map((x) => x.rssi as number)) : null,
  };
}

export const SessionStore = {
  async save(session: Session): Promise<void> {
    await tx('readwrite', (s) => s.put(session));
  },

  /**
   * Cria o arquivo vazio, antes de coletar.
   *
   * O fluxo antigo era coletar e depois "salvar como". Isso guardava uma
   * campanha inteira só na memória: fechar o app, ficar sem bateria ou o
   * Android matar o processo em segundo plano custava a coleta toda — e num
   * teste de alcance a coleta é a caminhada, que não se repete de graça.
   *
   * Criando o arquivo primeiro, cada ponto é gravado assim que chega.
   */
  async create(meta: Omit<Session, 'samples'>): Promise<Session> {
    const session: Session = { ...meta, samples: [] };
    await tx('readwrite', (s) => s.put(session));
    return session;
  },

  /**
   * Anexa pontos ao arquivo aberto.
   *
   * Regrava a sessão inteira em vez de manter um store separado por amostra:
   * com um ponto por segundo e o IndexedDB gravando em background, é barato o
   * bastante, e mantém a campanha como um objeto único — que é o que torna
   * exportar e enviar uma operação simples.
   */
  async append(id: string, samples: RangeSample[]): Promise<void> {
    if (!samples.length) return;
    const cur = await this.get(id);
    if (!cur) return;
    cur.samples = cur.samples.concat(samples);
    await tx('readwrite', (s) => s.put(cur));
  },

  /** Atualiza os metadados sem tocar nas amostras já gravadas. */
  async patch(id: string, patch: Partial<Omit<Session, 'samples' | 'id'>>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) return;
    await tx('readwrite', (s) => s.put({ ...cur, ...patch }));
  },

  async get(id: string): Promise<Session | undefined> {
    return tx('readonly', (s) => s.get(id) as IDBRequest<Session | undefined>);
  },

  async remove(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id) as unknown as IDBRequest<void>);
  },

  async list(): Promise<SessionSummary[]> {
    const all = await tx('readonly', (s) => s.getAll() as IDBRequest<Session[]>);
    return all.map(summarize).sort((a, b) => b.createdAt - a.createdAt);
  },

  /**
   * Exporta como GeoJSON — formato que QGIS, Google Earth e a maioria dos SIG
   * abrem direto, o que evita prender a campanha dentro deste app.
   */
  toGeoJSON(session: Session): string {
    const features = session.samples.map((p) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: p.altitude == null
          ? [p.longitude, p.latitude]
          : [p.longitude, p.latitude, p.altitude],
      },
      properties: {
        time: new Date(p.t).toISOString(),
        rssi: p.rssi,
        snr: p.snr,
        lq: p.lq,
        linked: p.linked,
        distance_m: p.distance,
        accuracy_m: p.accuracy,
      },
    }));

    if (session.origin) {
      features.unshift({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: session.origin.altitude == null
            ? [session.origin.longitude, session.origin.latitude]
            : [session.origin.longitude, session.origin.latitude, session.origin.altitude],
        },
        properties: { role: 'transmissor', source: session.origin.source } as never,
      });
    }

    return JSON.stringify(
      {
        type: 'FeatureCollection',
        name: session.name,
        properties: {
          createdAt: new Date(session.createdAt).toISOString(),
          band: session.band,
          freqMHz: session.freqMHz,
          powerDbm: session.powerDbm,
        },
        features,
      },
      null,
      2,
    );
  },

  /** CSV, pra quem vai abrir na planilha e fazer o gráfico RSSI × distância. */
  toCSV(session: Session): string {
    const head = 'tempo,latitude,longitude,altitude_m,precisao_m,distancia_m,rssi_dbm,snr_db,lq,enlace';
    const rows = session.samples.map((p) =>
      [
        new Date(p.t).toISOString(),
        p.latitude.toFixed(7),
        p.longitude.toFixed(7),
        p.altitude ?? '',
        p.accuracy ?? '',
        p.distance == null ? '' : p.distance.toFixed(1),
        p.rssi ?? '',
        p.snr ?? '',
        p.lq ?? '',
        p.linked ? '1' : '0',
      ].join(','),
    );
    return [head, ...rows].join('\n');
  },
};
