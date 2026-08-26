/**
 * GPS do celular.
 *
 * POR QUE NÃO `navigator.geolocation` DIRETO
 *
 * Ele existe no WebView do Android e até compila, mas não pede a permissão em
 * runtime: `ACCESS_FINE_LOCATION` declarado no manifest só dá o direito de
 * pedir, não a concessão. Sem o pedido nativo o watch falha calado ou devolve
 * posição de rede — que o filtro de precisão do app descarta, e a tela fica
 * eternamente sem pontos sem dizer por quê.
 *
 * Então: plugin do Capacitor no aparelho, API do navegador na mesa. Mesma
 * forma de retorno nos dois, para o resto do app não saber a diferença.
 */

import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { Diag } from './Diag';

/**
 * GPS que sobrevive à tela apagada.
 *
 * O @capacitor/geolocation usa o provedor comum, e desde o Android 8 um app
 * fora do primeiro plano recebe posição POUCAS VEZES POR HORA. Medido nesta
 * bancada: 4 fixes em 39 minutos de caminhada, com o celular no bolso — e como
 * o app amostrava por relógio, ele carimbou o mesmo fix congelado em 29 pontos.
 * A campanha inteira caiu num ponto só do mapa.
 *
 * Este plugin sobe um SERVIÇO EM PRIMEIRO PLANO com notificação, que é a única
 * forma que o Android reconhece para manter a localização fluindo em segundo
 * plano. A notificação não é opcional: é o preço da permissão.
 */
const BackgroundGeolocation =
  registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export interface Fix {
  latitude: number;
  longitude: number;
  /** metros; null quando o aparelho não reporta */
  altitude: number | null;
  /** precisão horizontal em metros */
  accuracy: number | null;
  t: number;
}

export interface GeoWatcher {
  stop: () => void;
}

/**
 * Espera pelo satélite.
 *
 * 15 s era o padrão e não serve: sob laje o primeiro fix leva minutos, e a céu
 * aberto com o chip frio passa fácil de um minuto. Um minuto inteiro é o que
 * evita o app declarar erro enquanto o aparelho ainda está fazendo a coisa
 * certa.
 */
const TIMEOUT_MS = 60000;

/**
 * Quanto tempo esperar antes de reatar o watch depois de um timeout.
 *
 * Timeout não é falha definitiva — é "ainda não achei". O watch morre quando
 * isso acontece, então quem quer um trajeto contínuo precisa reatá-lo, senão
 * uma passagem por um túnel encerra a coleta pelo resto da caminhada.
 */
const RETRY_MS = 3000;

const isNative = () =>
  typeof (window as any).Capacitor?.isNativePlatform === 'function' &&
  (window as any).Capacitor.isNativePlatform();

/**
 * Pede a permissão de localização. Devolve a mensagem do problema, ou null se
 * está tudo certo — mensagem em vez de boolean porque o motivo da recusa muda
 * o que o usuário precisa fazer.
 */
export async function ensurePermission(): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    let st = await Geolocation.checkPermissions();
    if (st.location !== 'granted') {
      st = await Geolocation.requestPermissions({ permissions: ['location'] });
    }
    Diag.info(`permissao de localizacao: ${st.location}`);
    if (st.location === 'granted') return null;
    if (st.location === 'denied') {
      return 'Permissão de localização negada. Ajustes → Apps → Alcance LoRa → Permissões.';
    }
    return `Permissão de localização: ${st.location}`;
  } catch (e) {
    return `Localização: ${e instanceof Error ? e.message : 'falha ao pedir permissão'}`;
  }
}

const isTimeout = (msg: string) =>
  /time|timeout|expired/i.test(msg);

/**
 * Acompanha a posição até `stop()`.
 *
 * `onStatus` recebe o que está acontecendo enquanto não há fix — é diferente de
 * erro, e tratar as duas coisas como erro faz a tela gritar vermelho enquanto o
 * aparelho apenas procura satélite.
 */
export async function watch(
  onFix: (f: Fix) => void,
  onError: (msg: string) => void,
  onStatus?: (msg: string) => void,
): Promise<GeoWatcher> {
  let stopped = false;
  let clear: (() => void) | null = null;
  let retryTimer: number | null = null;
  let gotFirst = false;

  // enableHighAccuracy força o chip de GPS em vez de triangulação de rede. Sem
  // isso a precisão fica na casa das centenas de metros, e um mapa de alcance
  // com esse erro inventa cobertura onde não há.
  // maximumAge 0: numa campanha em MOVIMENTO, posição em cache é posição errada.
  // Com 5 s o provedor podia devolver a leitura anterior como se fosse nova, e
  // não há como distinguir isso de "o aparelho não saiu do lugar".
  const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: TIMEOUT_MS };

  const handleErr = (msg: string) => {
    if (stopped) return;
    if (isTimeout(msg)) {
      // Ainda procurando. Reata e avisa sem alarme.
      onStatus?.(
        gotFirst
          ? 'GPS perdeu o sinal — procurando de novo'
          : 'Procurando satélite. Sob laje pode não achar; vá para céu aberto.',
      );
      clear?.();
      clear = null;
      retryTimer = window.setTimeout(() => void arm(), RETRY_MS);
      return;
    }
    onError(msg);
  };

  const deliver = (f: Fix) => {
    if (stopped) return;
    if (!gotFirst) Diag.info(`primeiro fix: ±${Math.round(f.accuracy ?? 0)} m`);
    gotFirst = true;
    onFix(f);
  };

  async function arm() {
    if (stopped) return;
    if (isNative()) {
      // `backgroundMessage` é o que liga o serviço em primeiro plano. Sem ele o
      // plugin só garante posição com o app à vista — que é exatamente o
      // problema que ele existe para resolver aqui.
      const id = await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: 'Gravando o trajeto do teste de alcance.',
          backgroundTitle: 'Alcance LoRa',
          requestPermissions: true,
          // stale false: o plugin segura a posição velha em vez de entregá-la
          // como se fosse nova. É a mesma decisão do maximumAge acima.
          stale: false,
          // Sem filtro de distância: num teste de alcance interessa também o
          // ponto onde o operador ficou parado esperando o sinal voltar.
          distanceFilter: 0,
        },
        (pos, err) => {
          if (err) {
            if (err.code === 'NOT_AUTHORIZED') {
              onError(
                'Permissão de localização em segundo plano negada. Ajustes → Apps → ' +
                  'Alcance LoRa → Permissões → Localização → Permitir o tempo todo.',
              );
              return;
            }
            handleErr(err.message ?? 'erro desconhecido');
            return;
          }
          if (!pos) return;
          deliver({
            latitude: pos.latitude,
            longitude: pos.longitude,
            altitude: pos.altitude,
            accuracy: pos.accuracy,
            t: pos.time ?? Date.now(),
          });
        },
      );
      clear = () => void BackgroundGeolocation.removeWatcher({ id });
    } else {
      const id = navigator.geolocation.watchPosition(
        (pos) =>
          deliver({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            altitude: pos.coords.altitude ?? null,
            accuracy: pos.coords.accuracy ?? null,
            t: pos.timestamp,
          }),
        (e) => handleErr(e.message),
        opts,
      );
      clear = () => navigator.geolocation.clearWatch(id);
    }
  }

  await arm();

  // Em paralelo, uma leitura rápida SEM exigir alta precisão.
  //
  // Só na mesa: no aparelho o plugin de segundo plano já entrega o primeiro
  // fix rápido, e semear com posição de rede aqui criava um ponto de centenas
  // de metros de erro no início de toda campanha.
  //
  // Serve só para a tela mostrar algo enquanto o chip de GPS ainda converge:
  // sai da última posição conhecida ou da rede, chega em segundos, e é
  // substituída pelo primeiro fix de satélite que vier. O watch acima continua
  // sendo a fonte real.
  void (async () => {
    try {
      if (isNative()) {
        const { Geolocation } = await import('@capacitor/geolocation');
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          maximumAge: 60000,
          timeout: 10000,
        });
        if (!gotFirst && !stopped) {
          deliver({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            altitude: pos.coords.altitude ?? null,
            accuracy: pos.coords.accuracy ?? null,
            t: pos.timestamp ?? Date.now(),
          });
        }
      }
    } catch {
      /* sem posição aproximada; o watch resolve */
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      clear?.();
      clear = null;
    },
  };
}
