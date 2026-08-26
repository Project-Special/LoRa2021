import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { RangeSample, TxOrigin } from '../types';
import { Fix } from '../services/GeoService';
import { formatDistance, rssiColor } from '../lib/geo';
import { TRAIL_DOWN, TRAIL_OK } from '../lib/link';

interface Props {
  samples: RangeSample[];
  origin: TxOrigin | null;
  /** Segue a última amostra. Desligar deixa o usuário arrastar sem o mapa puxar de volta. */
  follow: boolean;
  /** Posição atual, usada como centro enquanto não há ponto nem origem. */
  fix: Fix | null;
}

export const RangeMap: React.FC<Props> = ({ samples, origin, follow, fix }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Centro inicial: onde o aparelho está. O padrão fixo mostrava São Paulo
    // para quem estivesse em qualquer outro lugar — e um mapa da cidade errada
    // é pior que um mapa vazio, porque parece que os pontos sumiram.
    const start: L.LatLngExpression = fix
      ? [fix.latitude, fix.longitude]
      : samples.length
        ? [samples[0].latitude, samples[0].longitude]
        : origin
          ? [origin.latitude, origin.longitude]
          : [0, 0];

    const map = L.map(containerRef.current, { zoomControl: true })
      .setView(start, fix || samples.length || origin ? 16 : 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);

    // invalidateSize é obrigatório aqui.
    //
    // O Leaflet mede o container UMA vez, na criação. Dentro de um layout flex
    // que ainda está se acomodando — e com a barra do Android entrando depois —
    // ele mede menor do que o tamanho final, carrega tiles só para aquela faixa
    // e deixa o resto cinza. Era exatamente o mapa "pela metade".
    const kick = () => map.invalidateSize();
    kick();
    const t1 = window.setTimeout(kick, 100);
    const t2 = window.setTimeout(kick, 500);

    // E remede sempre que o container mudar: rotação de tela, teclado subindo,
    // barra de navegação aparecendo.
    const ro = new ResizeObserver(kick);
    ro.observe(containerRef.current);
    window.addEventListener('orientationchange', kick);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      window.removeEventListener('orientationchange', kick);
    };
  }, []);

  // Sem pontos ainda, o mapa acompanha o GPS: dá para conferir que o aparelho
  // está no lugar certo antes de começar a caminhar.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix || samples.length) return;
    map.setView([fix.latitude, fix.longitude], Math.max(map.getZoom(), 16));
  }, [fix, samples.length]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    if (origin) {
      L.circleMarker([origin.latitude, origin.longitude], {
        radius: 9,
        color: '#ffffff',
        weight: 2,
        fillColor: '#137fec',
        fillOpacity: 1,
      })
        .bindPopup('<b>Transmissor</b>')
        .addTo(layer);

      // Anéis de referência: dão escala ao mapa sem precisar medir nada.
      [250, 500, 1000, 2000].forEach((r) => {
        L.circle([origin.latitude, origin.longitude], {
          radius: r,
          color: '#137fec',
          weight: 1,
          opacity: 0.35,
          fill: false,
          dashArray: '4 6',
        }).addTo(layer);
      });
    }

    // Rastro pintado pelo enlace, no mesmo verde e vermelho do LED.
    //
    // Uma linha cinza única escondia exatamente o que a campanha procura: o
    // trecho do percurso onde a comunicação caiu. Aqui cada trecho leva a cor
    // do enlace que havia ali, e o ponto onde o verde vira vermelho é o
    // resultado do teste.
    //
    // Trechos de mesma cor viram uma polilinha só — uma por segmento faria
    // centenas de camadas numa campanha longa, e o mapa engasgaria ao arrastar.
    if (samples.length > 1) {
      const at = (s: RangeSample): L.LatLngExpression => [s.latitude, s.longitude];
      let run: L.LatLngExpression[] = [];
      let runOk: boolean | null = null;

      const flush = () => {
        if (run.length < 2 || runOk === null) return;
        L.polyline(run, {
          color: runOk ? TRAIL_OK : TRAIL_DOWN,
          weight: 4,
          opacity: 0.85,
          // Tracejado no vermelho: o trecho sem enlace continua legível para
          // quem não distingue as duas cores, e em tela ao sol.
          dashArray: runOk ? undefined : '6 6',
        }).addTo(layer);
      };

      for (let i = 1; i < samples.length; i++) {
        // O trecho só é verde se havia enlace nas duas pontas: meio caminho
        // sem link não é meio verde, é perda.
        const ok = samples[i - 1].linked && samples[i].linked;
        if (ok !== runOk) {
          flush();
          run = [at(samples[i - 1])];
          runOk = ok;
        }
        run.push(at(samples[i]));
      }
      flush();
    }

    samples.forEach((s) => {
      L.circleMarker([s.latitude, s.longitude], {
        radius: 5,
        // Mesma lógica do rastro na borda; o miolo continua sendo o RSSI, que
        // é a intensidade — a borda é o sim/não.
        color: s.linked ? TRAIL_OK : TRAIL_DOWN,
        weight: 2,
        fillColor: rssiColor(s.rssi),
        fillOpacity: 0.9,
      })
        .bindPopup(
          `<b>${s.rssi ?? '—'} dBm</b><br>` +
            `SNR ${s.snr ?? '—'} dB<br>` +
            `dist ${formatDistance(s.distance)}<br>` +
            `alt ${s.altitude == null ? '—' : `${Math.round(s.altitude)} m`}<br>` +
            `${new Date(s.t).toLocaleTimeString('pt-BR')}` +
            (s.linked ? '' : '<br><b style="color:#ef4444">sem enlace</b>'),
        )
        .addTo(layer);
    });

    if (!samples.length) return;
    const last = samples[samples.length - 1];
    if (follow) {
      map.panTo([last.latitude, last.longitude], { animate: true });
    } else if (!fittedRef.current) {
      // Enquadra uma vez ao abrir uma sessão salva; depois respeita o usuário.
      const pts: L.LatLngExpression[] = samples.map((s) => [s.latitude, s.longitude]);
      if (origin) pts.push([origin.latitude, origin.longitude]);
      map.fitBounds(L.latLngBounds(pts).pad(0.15));
      fittedRef.current = true;
    }
  }, [samples, origin, follow]);

  // Sessão nova volta a merecer um enquadramento.
  useEffect(() => {
    fittedRef.current = false;
  }, [origin]);

  return <div ref={containerRef} className="w-full h-full" />;
};
