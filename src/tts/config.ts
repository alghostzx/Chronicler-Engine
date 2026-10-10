/** Configuração da narração: modelos, vozes pré-definidas e valores padrão. */

export const TTS_MODELS: { id: string; label: string }[] = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS (padrão)' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash Lite TTS (mais barato)' },
];

/** As 30 vozes pré-definidas do Gemini TTS, com o traço de cada uma. */
export const TTS_VOICES: { id: string; trait: string }[] = [
  { id: 'Achernar', trait: 'suave' },
  { id: 'Achird', trait: 'amigável' },
  { id: 'Algenib', trait: 'rouca' },
  { id: 'Algieba', trait: 'macia' },
  { id: 'Alnilam', trait: 'firme' },
  { id: 'Aoede', trait: 'leve' },
  { id: 'Autonoe', trait: 'brilhante' },
  { id: 'Callirrhoe', trait: 'tranquila' },
  { id: 'Charon', trait: 'informativa' },
  { id: 'Despina', trait: 'macia' },
  { id: 'Enceladus', trait: 'sussurrada' },
  { id: 'Erinome', trait: 'clara' },
  { id: 'Fenrir', trait: 'empolgada' },
  { id: 'Gacrux', trait: 'madura' },
  { id: 'Iapetus', trait: 'clara' },
  { id: 'Kore', trait: 'firme' },
  { id: 'Laomedeia', trait: 'animada' },
  { id: 'Leda', trait: 'jovem' },
  { id: 'Orus', trait: 'firme' },
  { id: 'Puck', trait: 'animada' },
  { id: 'Pulcherrima', trait: 'direta' },
  { id: 'Rasalgethi', trait: 'informativa' },
  { id: 'Sadachbia', trait: 'vivaz' },
  { id: 'Sadaltager', trait: 'erudita' },
  { id: 'Schedar', trait: 'uniforme' },
  { id: 'Sulafat', trait: 'calorosa' },
  { id: 'Umbriel', trait: 'tranquila' },
  { id: 'Vindemiatrix', trait: 'gentil' },
  { id: 'Zephyr', trait: 'brilhante' },
  { id: 'Zubenelgenubi', trait: 'casual' },
];

export const TTS_DEFAULTS = {
  auto_default: false,
  model: 'gemini-3.8-flash-tts',
  /** "Mature": a que o autor escolheu entre as amostras (sem sotaque marcado). */
  voice: 'Gacrux',
  /** Ritmo e tom (a idade/o sotaque vêm da escolha da voz, não do estilo). */
  style: 'voz grave, rouca e pausada de um velho narrador',
};

/** Texto lido pelo botão "Ouvir amostra" das configurações. */
export const TTS_SAMPLE_TEXT =
  'A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava.';

export const TTS_STYLE_MAX = 300;
