// Question library helpers shared by the library page and the exam editors.
export const DIFFICULTIES = [
  { value: "easy",   label: "Easy",   tone: "success" },
  { value: "medium", label: "Medium", tone: "warning" },
  { value: "hard",   label: "Hard",   tone: "danger"  },
];
export const difficultyMeta = (v) => DIFFICULTIES.find((d) => d.value === v) || DIFFICULTIES[1];

export const MAX_TOPIC_LEN = 100;
export const AI_MAX_QUESTIONS = 20;

/** Same normalisation as the backend's duplicate check (case, punctuation and spacing ignored). */
export const normalizeText = (t) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** An editor question is ready to be stored only when it is complete. */
export const isCompleteQuestion = (q) =>
  !!q.text?.trim() && q.options?.length === 4 && q.options.every((o) => o?.trim()) && q.correctAnswer !== null && q.correctAnswer !== undefined;

export const errMsg = (err, fallback = "Something went wrong. Please try again.") =>
  err?.response?.data?.message || err?.message || fallback;
