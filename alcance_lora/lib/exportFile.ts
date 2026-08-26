/**
 * Entrega um texto ao usuário num WebView do Android.
 *
 * `<a download>` com blob: NÃO funciona aqui. O WebView do Capacitor não tem
 * DownloadListener registrado, então o clique não faz nada — sem erro, sem
 * arquivo, sem aviso. Era o motivo de "CSV e GeoJSON não funcionam": os botões
 * estavam certos e o navegador é que engolia o pedido em silêncio.
 *
 * A ordem abaixo vai do melhor ao que sempre funciona:
 *
 *   1. Web Share com arquivo — abre o menu de compartilhar do Android, e o
 *      arquivo vai para o WhatsApp, o Drive ou o e-mail.
 *   2. Área de transferência — cola em qualquer lugar. Uma campanha de 3000
 *      pontos dá ~250 kB de CSV, que o clipboard aguenta.
 *   3. Download de navegador — no Chrome de mesa, onde se desenvolve, é o
 *      caminho natural e continua valendo.
 *
 * O que NÃO se faz aqui é falhar calado: quem chama recebe o que aconteceu
 * para poder dizer na tela.
 */
export type ExportResult =
  | { via: 'share'; message: string }
  | { via: 'clipboard'; message: string }
  | { via: 'download'; message: string }
  | { via: 'none'; message: string };

export async function exportText(
  filename: string,
  mime: string,
  body: string,
): Promise<ExportResult> {
  const size = `${Math.round(body.length / 1024)} kB`;

  // 1. compartilhar o arquivo
  try {
    const file = new File([body], filename, { type: mime });
    const nav = navigator as Navigator & {
      canShare?: (d: { files?: File[] }) => boolean;
      share?: (d: { files?: File[]; title?: string }) => Promise<void>;
    };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: filename });
      return { via: 'share', message: `${filename} compartilhado (${size}).` };
    }
  } catch (e) {
    // Cancelar o menu de compartilhar cai aqui e NÃO é erro: quem cancelou não
    // quer o passo seguinte tentando de novo por conta própria.
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { via: 'none', message: 'Compartilhamento cancelado.' };
    }
  }

  // 2. área de transferência
  try {
    await navigator.clipboard.writeText(body);
    return {
      via: 'clipboard',
      message: `${filename} copiado (${size}) — cole no WhatsApp, e-mail ou Drive.`,
    };
  } catch {
    // segue para o download
  }

  // 3. download de navegador
  try {
    const url = URL.createObjectURL(new Blob([body], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return { via: 'download', message: `${filename} baixado (${size}).` };
  } catch {
    return {
      via: 'none',
      message: `Não foi possível entregar ${filename}. Envie para a nuvem em vez disso.`,
    };
  }
}
