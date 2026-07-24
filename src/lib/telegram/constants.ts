// ── Telegram Bot Constants ───────────────────────────────────────

export const LANGUAGES = [
  { code: "id", label: "🇮🇩 Indonesia" },
  { code: "en", label: "🇬🇧 English" },
  { code: "ja", label: "🇯🇵 Japanese" },
  { code: "zh", label: "🇨🇳 Mandarin" },
  { code: "es", label: "🇪🇸 Spanish" },
  { code: "fr", label: "🇫🇷 French" },
  { code: "ko", label: "🇰🇷 Korean" },
  { code: "ar", label: "🇸🇦 Arabic" },
] as const;

export const DURATIONS = [5, 15, 30] as const;

export const NODE_EMOJI: Record<string, string> = {
  input: "📝",
  producer: "🎬",
  writer: "✍️",
  reviewer: "🔍",
  actor: "🎭",
  tts: "🗣️",
  video: "🎥",
  telegram: "📨",
  cloud: "☁️",
  telegram_trigger: "📡",
};
