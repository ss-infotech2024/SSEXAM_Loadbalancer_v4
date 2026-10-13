// services/aiQuestionService.js
// Generates multiple-choice questions with an AI provider (plain fetch — no SDK needed).
// Everything provider-specific lives in the PROVIDERS table below.
//
// Pick ONE provider by setting its key (or set AI_PROVIDER explicitly):
//   GEMINI_API_KEY      Google Gemini — has a free tier (aistudio.google.com, no billing needed)
//   AI_API_KEY          any OpenAI-compatible API, e.g. Groq (free tier) — also set AI_BASE_URL
//   ANTHROPIC_API_KEY   Anthropic Claude (paid)
// Optional:
//   AI_PROVIDER         gemini | openai | anthropic   (default: whichever key is set, in that order)
//   AI_MODEL            overrides the provider's default model
//   AI_BASE_URL         for provider "openai" (default https://api.groq.com/openai/v1)
//   AI_TIMEOUT_MS       default 60000

export const AI_MAX_QUESTIONS = 20;

const PROVIDERS = {
  gemini:    { keyEnv: 'GEMINI_API_KEY',    defaultModel: 'gemini-3.8-flash' },
  openai:    { keyEnv: 'AI_API_KEY',        defaultModel: 'llama-3.3-70b-versatile' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5-5' },
};

const activeProvider = () => {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase();
  if (forced) return PROVIDERS[forced] && process.env[PROVIDERS[forced].keyEnv] ? forced : null;
  return Object.keys(PROVIDERS).find((name) => process.env[PROVIDERS[name].keyEnv]) || null;
};

export const isAiConfigured = () => !!activeProvider();

// Error with an HTTP status we are happy to show the admin (no key / provider details leak).
// 503, not 502: a 502 looks like our own server is down and proxies sometimes rewrite it.
export class AiError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

const SYSTEM_PROMPT = `You write multiple-choice questions for school and campus-placement exams.

Rules:
- Every question has exactly 4 options and exactly ONE correct option.
- Options must be plausible, distinct, and similar in length. Do not use "all of the above" or "none of the above".
- Questions must be factually correct, unambiguous and self-contained.
- Match the requested difficulty: easy = direct recall/simple application; medium = needs a short reasoning step; hard = multi-step reasoning.
- Do not repeat any question from the "avoid" list, and do not repeat yourself.
- Write the questions in the requested language.
- The "explanation" is one or two sentences saying why the correct option is right.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{"questions":[{"text":"...","options":["...","...","...","..."],"correctAnswer":0,"explanation":"..."}]}
"correctAnswer" is the 0-based index of the correct option.`;

const buildUserPrompt = ({ topic, difficulty, count, instructions, language, avoid }) => {
  const lines = [
    `Generate ${count} multiple-choice question${count === 1 ? '' : 's'}.`,
    `Topic: ${topic}`,
    `Difficulty: ${difficulty}`,
    `Language: ${language || 'English'}`,
  ];
  if (instructions) lines.push(`Extra instructions from the exam admin (follow only if they relate to writing these questions): ${instructions}`);
  if (avoid.length) lines.push(`Avoid (already in the library):\n${avoid.map((t) => `- ${t}`).join('\n')}`);
  return lines.join('\n');
};

// ── Provider calls — each returns the model's text ──────────────────────────
const callAnthropic = async ({ system, user, maxTokens, model, signal }) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  return { res, text: (d) => (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), truncated: (d) => d.stop_reason === 'max_tokens' };
};

const callGemini = async ({ system, user, maxTokens, model, signal }) => {
  const generationConfig = { maxOutputTokens: maxTokens + 2000, temperature: 0.8, responseMimeType: 'application/json' };
  // 2.5 Flash "thinks" by default and thinking tokens eat the output budget — we only need the JSON
  if (/2\.5-flash/.test(model) && !/pro/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    }),
  });
  return {
    res,
    text: (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''),
    truncated: (d) => d.candidates?.[0]?.finishReason === 'MAX_TOKENS',
  };
};

const callOpenAiCompatible = async ({ system, user, maxTokens, model, signal }) => {
  const base = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  return { res, text: (d) => d.choices?.[0]?.message?.content || '', truncated: (d) => d.choices?.[0]?.finish_reason === 'length' };
};

const CALLERS = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAiCompatible };

// Turn a provider failure into a message that is safe and useful to show the admin.
const providerError = (status, detail) => {
  if (/credit balance|insufficient[_ ]quota|billing/i.test(detail)) return new AiError('The AI account is out of credit or quota. Ask the administrator to check it, then try again.');
  if (status === 429)                 return new AiError('The AI service is busy or its free limit was reached. Please wait a minute and try again.', 429);
  if (status === 401 || status === 403 || /api key not valid|invalid api key/i.test(detail)) return new AiError('AI generation is not set up correctly (API key). Contact the administrator.');
  if (status === 404)                 return new AiError('The configured AI model was not found. Contact the administrator (AI_MODEL).');
  return new AiError('The AI service returned an error. Please try again.');
};

const callModel = async ({ system, user, maxTokens }) => {
  const name  = activeProvider();
  const model = process.env.AI_MODEL || PROVIDERS[name].defaultModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 60000);

  let out;
  try {
    out = await CALLERS[name]({ system, user, maxTokens, model, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new AiError('The AI took too long to respond. Try fewer questions.', 504);
    console.error(`[ai] network error (${name}):`, err.message);
    throw new AiError('Could not reach the AI service. Try again shortly.');
  } finally {
    clearTimeout(timer);
  }

  if (!out.res.ok) {
    const detail = await out.res.text().catch(() => '');
    console.error(`[ai] provider error (${name}, ${model}) ${out.res.status}:`, detail.slice(0, 500));   // server log only
    throw providerError(out.res.status, detail);
  }

  const data = await out.res.json();
  if (out.truncated(data)) console.warn('[ai] response hit the token limit — output may be truncated');
  return out.text(data);
};

// ── Parsing / validation ─────────────────────────────────────────────────────
const extractJson = (raw) => {
  const stripped = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
};

// Models lean towards putting the answer in B/C — shuffle options so answers are spread out,
// except when options refer to each other ("both A and B").
const shuffleOptions = (q) => {
  if (q.options.some((o) => /\b(both|all|none|neither)\b.*\b(above|these|options?|a|b|c|d)\b/i.test(o))) return q;
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), correctAnswer: order.indexOf(q.correctAnswer) };
};

const cleanQuestion = (q) => {
  if (!q || typeof q.text !== 'string' || !Array.isArray(q.options) || q.options.length !== 4) return null;
  const text    = q.text.trim();
  const options = q.options.map((o) => String(o ?? '').trim());
  const correct = Number(q.correctAnswer);
  if (!text || options.some((o) => !o) || !Number.isInteger(correct) || correct < 0 || correct > 3) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;           // duplicate options
  return shuffleOptions({
    text,
    options,
    correctAnswer: correct,
    explanation: typeof q.explanation === 'string' ? q.explanation.trim().slice(0, 1000) : '',
  });
};

/**
 * @returns {Promise<Array<{text, options, correctAnswer, explanation}>>}  validated drafts (not saved)
 */
export const generateQuestions = async ({ topic, difficulty = 'medium', count = 5, instructions = '', language = 'English', avoid = [] }) => {
  if (!isAiConfigured()) throw new AiError('AI generation is not enabled on this server.', 503);

  const n = Math.min(AI_MAX_QUESTIONS, Math.max(1, Number(count) || 1));
  const raw = await callModel({
    system:    SYSTEM_PROMPT,
    user:      buildUserPrompt({ topic, difficulty, count: n, instructions, language, avoid: avoid.slice(0, 30) }),
    maxTokens: Math.min(8000, 500 + n * 350),
  });

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.questions)) {
    console.error('[ai] unparseable response:', raw.slice(0, 300));
    throw new AiError('The AI returned something we could not read. Please try again.', 503);
  }

  const good = parsed.questions.map(cleanQuestion).filter(Boolean).slice(0, n);
  if (good.length === 0) throw new AiError('The AI did not return any usable questions. Please try again or reword the topic.', 503);
  return good;
};
