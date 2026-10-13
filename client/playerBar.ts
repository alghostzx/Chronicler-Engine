import { audioPlayer, formatClock, RATES } from './audioPlayer';
import type { ContinuousPlayback } from './continuousPlayback';
import { statusText } from './continuousUi';
import { iconButton } from './controls';
import { h } from './dom';
import { icon } from './icons';

/**
 * Barra fixa do player de narração, sempre visível enquanto há uma faixa carregada: é onde ficam os
 * controles de mídia (tocar/pausar, posição, velocidade), em vez de um player dentro de cada página.
 *
 * - Uma página tocando fora do modo contínuo: "Tocando a Página N de «crônica»" + botão de fechar.
 * - Modo contínuo: "Reproduzindo «crônica» em modo contínuo", página anterior/próxima e Interromper.
 *
 * A barra só reflete `audioPlayer` (e, se houver, o `ContinuousPlayback`); não guarda áudio nem estado.
 */

export interface PlayerBarOptions {
  /** Reprodução contínua da tela (só na sessão; o leitor de volumes toca uma página por vez). */
  continuous?: ContinuousPlayback;
  /** "Interromper": o chamador para o modo contínuo e o reprodutor (a barra então se esconde). */
  onStopContinuous?: () => void;
  /** Título atual da crônica (cai no `artist` da faixa quando não informado). */
  title?: () => string;
}

export interface PlayerBar {
  el: HTMLElement;
  /** Solta os ouvintes (a barra sai de cena junto com a tela). */
  dispose(): void;
}

export function createPlayerBar(opts: PlayerBarOptions = {}): PlayerBar {
  const { continuous } = opts;

  const heading = h('p', { class: 'player-bar-title' });
  const detail = h('p', { class: 'player-bar-detail' });
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite', 'data-player-live': '' });
  const headIcon = h('span', { class: 'player-bar-icon' });

  const stopContinuous = h(
    'button',
    { type: 'button', class: 'btn btn-danger player-bar-stop hidden', 'aria-label': 'Interromper a reprodução contínua', onClick: () => opts.onStopContinuous?.() },
    icon('stop', 16),
    h('span', null, 'Interromper'),
  );
  const closeSingle = iconButton({ icon: 'close', label: 'Fechar o player', tip: 'Fechar o player e parar o áudio', align: 'end', onClick: () => audioPlayer.stop() });
  closeSingle.classList.add('player-bar-close');

  const prev = iconButton({ icon: 'skipBack', label: 'Página anterior', align: 'start', up: true, onClick: () => continuous?.previous() }) as HTMLButtonElement;
  const next = iconButton({ icon: 'skipForward', label: 'Próxima página', align: 'start', up: true, onClick: () => continuous?.next() }) as HTMLButtonElement;
  const playBtn = iconButton({ icon: 'play', label: 'Tocar', align: 'start', up: true, onClick: () => (audioPlayer.state.playing ? audioPlayer.pause() : void audioPlayer.resume()) }) as HTMLButtonElement;
  playBtn.classList.add('player-bar-play');
  const seek = h('input', { type: 'range', class: 'audio-seek', min: '0', max: '1', step: '0.1', value: '0', 'aria-label': 'Posição do áudio' });
  const time = h('span', { class: 'audio-time', 'aria-hidden': 'true' }, '0:00');
  const rateBtn = h('button', { type: 'button', class: 'btn audio-rate tip tip-end tip-up', 'data-tip': 'Velocidade de reprodução' });

  const el = h(
    'div',
    { class: 'player-bar hidden', role: 'region', 'aria-label': 'Player de narração', 'data-player-bar': '' },
    h('div', { class: 'player-bar-head' }, headIcon, h('div', { class: 'player-bar-text' }, heading, detail), stopContinuous, closeSingle),
    h('div', { class: 'player-bar-controls' }, prev, playBtn, next, seek, time, rateBtn),
    live,
  );

  let dragging = false;
  let lastPlaying: boolean | null = null;
  let lastMode = '';
  let lastPage = -1;

  seek.addEventListener('input', () => {
    dragging = true;
    time.textContent = `${formatClock(Number(seek.value))} / ${formatClock(Number(seek.max))}`;
  });
  seek.addEventListener('change', () => {
    dragging = false;
    audioPlayer.seek(Number(seek.value));
  });
  rateBtn.addEventListener('click', () => {
    const i = RATES.indexOf(audioPlayer.rate as (typeof RATES)[number]);
    audioPlayer.setRate(RATES[(i + 1) % RATES.length]!);
  });

  function render(): void {
    const track = audioPlayer.currentTrack;
    const cs = continuous?.state ?? null;
    if (!track && !cs) {
      el.classList.add('hidden');
      lastPage = -1;
      lastMode = '';
      return;
    }
    el.classList.remove('hidden');
    const s = audioPlayer.state;
    // Esperando a geração: o reprodutor ainda guarda a faixa anterior, que não é a página atual do modo.
    const waiting = cs?.phase === 'waiting';
    const chronicle = opts.title?.() ?? track?.artist ?? '';

    const mode = cs ? 'continuous' : 'single';
    if (mode !== lastMode) {
      lastMode = mode;
      el.setAttribute('data-mode', mode);
      headIcon.replaceChildren(icon(cs ? 'playFrom' : 'volume', 20));
      headIcon.title = cs ? 'Reprodução contínua' : 'Uma página';
      stopContinuous.classList.toggle('hidden', !cs);
      closeSingle.classList.toggle('hidden', !!cs);
      prev.classList.toggle('hidden', !cs);
      next.classList.toggle('hidden', !cs);
    }

    if (cs) {
      // O ícone de lista com seta já diz "reprodução contínua"; o texto fica só com o nome da crônica
      // (espaço no celular). Leitores de tela ouvem o texto completo (aria-label da região e dica).
      heading.textContent = `«${chronicle}»`;
      heading.title = 'Reprodução contínua';
      el.setAttribute('aria-label', `Player de narração, reproduzindo «${chronicle}» em modo contínuo`);
      detail.textContent = `Página ${cs.currentNumber} · ${cs.index + 1} de ${cs.pageIds.length} · ${statusText(cs)}`;
      next.disabled = cs.index + 1 >= cs.pageIds.length;
      // Anúncio para leitores de tela só quando a página muda (não a cada atualização de status).
      if (cs.currentNumber !== lastPage) {
        lastPage = cs.currentNumber;
        live.textContent = `Reproduzindo a Página ${cs.currentNumber}.`;
      }
    } else if (track) {
      heading.textContent = `Tocando a ${track.title} de «${chronicle}»`;
      heading.removeAttribute('title');
      el.setAttribute('aria-label', 'Player de narração');
      detail.textContent = s.playing ? 'Tocando' : 'Pausado';
      lastPage = -1;
    }

    const duration = waiting ? 0 : s.duration;
    const current = waiting ? 0 : s.time;
    seek.disabled = waiting;
    playBtn.disabled = waiting;
    seek.max = String(duration || 1);
    if (!dragging) seek.value = String(current);
    seek.setAttribute('aria-valuetext', `${formatClock(current)} de ${formatClock(duration)}`);
    if (!dragging) time.textContent = `${formatClock(current)} / ${formatClock(duration)}`;

    const playing = !waiting && s.playing;
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
      const label = playing ? 'Pausar' : 'Tocar';
      playBtn.setAttribute('aria-label', label);
      playBtn.setAttribute('data-tip', label);
      playBtn.setAttribute('aria-pressed', String(playing));
    }
    const r = audioPlayer.rate;
    rateBtn.textContent = `${r}×`;
    rateBtn.setAttribute('aria-label', `Velocidade de reprodução: ${r}×. Clique para mudar.`);
  }

  const unsubscribers = [audioPlayer.subscribe(render)];
  if (continuous) unsubscribers.push(continuous.subscribe(render));
  render();

  return {
    el,
    dispose() {
      for (const off of unsubscribers.splice(0)) off();
    },
  };
}
