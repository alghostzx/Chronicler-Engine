import { api, type TtsSettingsInfo } from '../api';
import { confirmModal, h, mount, toast } from '../dom';

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`;

/** Amostra em reprodução (só uma por vez). */
let sampleAudio: HTMLAudioElement | null = null;

/**
 * Cartão "Narração por voz" da tela inicial: padrão global da geração automática, modelo/voz/estilo,
 * amostra e uso de armazenamento. A geração automática de cada sessão fica na gaveta da sessão.
 */
export function createTtsSettingsCard(): HTMLElement {
  const body = h('div', { class: 'space-y-4' }, h('p', { class: 'text-sm text-muted' }, 'Consultando a narração…'));
  const card = h(
    'section',
    { class: 'card min-w-0 space-y-4', 'aria-label': 'Narração por voz' },
    h('h2', { class: 'font-display text-lg text-strong' }, 'Narração por voz'),
    body,
  );

  let tts: TtsSettingsInfo;

  function render(): void {
    const auto = h('input', { type: 'checkbox', id: 'tts-auto', class: 'mr-2', checked: tts.auto_default });
    auto.addEventListener('change', async () => {
      try {
        const r = await api<TtsSettingsInfo>('PUT', '/api/settings/tts', { auto_default: auto.checked });
        tts = { ...tts, auto_default: r.auto_default };
        toast(r.auto_default ? 'Narração automática ligada por padrão.' : 'Narração automática desligada por padrão.', 'success');
      } catch (err) {
        auto.checked = !auto.checked;
        toast((err as Error).message, 'error');
      }
    });

    const model = h('select', { class: 'input', 'aria-label': 'Modelo de voz' }, ...tts.models.map((m) => h('option', { value: m.id, selected: m.id === tts.model }, m.label)));
    if (!tts.models.some((m) => m.id === tts.model)) model.prepend(h('option', { value: tts.model, selected: true }, tts.model));
    const voice = h(
      'select',
      { class: 'input', 'aria-label': 'Voz do narrador' },
      ...tts.voices.map((v) => h('option', { value: v.id, selected: v.id === tts.voice }, `${v.id} — ${v.trait}${v.id === tts.defaults.voice ? ' (padrão)' : ''}`)),
    );
    if (!tts.voices.some((v) => v.id === tts.voice)) voice.prepend(h('option', { value: tts.voice, selected: true }, tts.voice));
    const style = h('textarea', {
      class: 'input min-h-[4.5rem]',
      maxlength: String(tts.style_max),
      'aria-label': 'Estilo da narração',
      placeholder: tts.defaults.style,
      value: tts.style,
    });

    const sampleBtn = h('button', { class: 'btn', type: 'button' }, 'Ouvir amostra');
    sampleBtn.addEventListener('click', async () => {
      sampleBtn.disabled = true;
      sampleBtn.textContent = 'Gerando a amostra…';
      try {
        const res = await fetch('/api/settings/tts/sample', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model.value, voice: voice.value, style: style.value }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          throw new Error(err.code === 'missing_api_key' ? 'Configure a chave da API do Gemini acima para ouvir a amostra.' : (err.error ?? `Erro HTTP ${res.status}`));
        }
        const url = URL.createObjectURL(await res.blob());
        sampleAudio?.pause();
        sampleAudio = new Audio(url);
        sampleAudio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
        await sampleAudio.play();
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        sampleBtn.disabled = false;
        sampleBtn.textContent = 'Ouvir amostra';
      }
    });

    const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Salvar voz');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const r = await api<TtsSettingsInfo>('PUT', '/api/settings/tts', { model: model.value, voice: voice.value, style: style.value });
        tts = { ...tts, model: r.model, voice: r.voice, style: r.style };
        toast('Voz salva. Vale para os próximos áudios; os já gerados não mudam.', 'success');
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        save.disabled = false;
      }
    });
    const restore = h('button', { class: 'btn', type: 'button', onClick: () => {
      model.value = tts.defaults.model;
      voice.value = tts.defaults.voice;
      style.value = tts.defaults.style;
    } }, 'Restaurar padrão');

    const usage = h('p', { class: 'text-sm text-muted', 'data-tts-usage': 'true' }, usageText());
    const purge = h('button', { class: 'btn btn-danger', type: 'button', disabled: tts.usage.count === 0 }, 'Apagar todos os áudios');
    purge.addEventListener('click', async () => {
      if (!(await confirmModal('Apagar todos os áudios', 'Apagar as narrações de todas as páginas de todas as crônicas? Os textos não são alterados; para ouvir de novo será preciso gerar o áudio outra vez (consome tokens de voz).', { danger: true, confirmLabel: 'Apagar tudo' }))) return;
      try {
        const r = await api<{ deleted: number; usage: TtsSettingsInfo['usage'] }>('DELETE', '/api/audio');
        tts = { ...tts, usage: r.usage };
        usage.textContent = usageText();
        purge.disabled = true;
        toast(`${r.deleted} áudio(s) apagado(s).`, 'success');
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    });

    mount(
      body,
      h(
        'p',
        { class: 'text-sm text-muted' },
        'Um narrador lê as páginas em voz alta (Gemini TTS, em português do Brasil). O áudio fica guardado no banco, então ouvir de novo não gasta nada; ele é descartado se a página for editada, re-gerada ou ramificada.',
      ),
      h('label', { class: 'flex items-start text-sm text-ink', for: 'tts-auto' }, auto, h('span', null, 'Narrar automaticamente cada página nova ', h('span', { class: 'text-muted' }, '(padrão global; cada crônica pode mudar isso na gaveta de contexto → Voz). Consome tokens de voz.'))),
      h(
        'div',
        { class: 'grid grid-cols-1 gap-3 sm:grid-cols-2' },
        h('div', { class: 'min-w-0' }, h('label', { class: 'label' }, 'Voz'), voice),
        h('div', { class: 'min-w-0' }, h('label', { class: 'label' }, 'Modelo de voz'), model),
      ),
      h('div', null, h('label', { class: 'label' }, 'Estilo (ritmo e tom)'), style, h('p', { class: 'mt-1 text-xs text-muted' }, 'A idade e o sotaque vêm da escolha da voz; o estilo ajusta ritmo e tom. A voz padrão (Gacrux) é madura; “Algenib” é rouca.')),
      h('div', { class: 'flex flex-wrap gap-2' }, save, sampleBtn, restore),
      h('hr', { class: 'border-line' }),
      h('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, usage, purge),
      h('p', { class: 'text-xs text-muted' }, 'Privacidade e custo: o texto das páginas é enviado ao Google para gerar a voz, e o áudio é cobrado como tokens de saída (cerca de 1,5 mil por minuto de áudio).'),
    );
  }

  function usageText(): string {
    const { count, bytes } = tts.usage;
    return count === 0 ? 'Nenhum áudio guardado.' : `${count} ${count === 1 ? 'áudio guardado' : 'áudios guardados'} (${formatBytes(bytes)}).`;
  }

  void api<TtsSettingsInfo>('GET', '/api/settings/tts').then(
    (r) => {
      tts = r;
      render();
    },
    (err) => mount(body, h('p', { class: 'text-sm text-hp-low' }, (err as Error).message)),
  );
  return card;
}
