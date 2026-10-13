// Exam sections are defined by the admin, per exam (the Sections card in Create / Edit Exam).
// A question's `section` is the name of one of its exam's sections, or empty for none.
// Limits mirror MAX_SECTIONS / MAX_SECTION_NAME_LEN in backend/models/exam.model.js.
export const MAX_SECTIONS         = 20;
export const MAX_SECTION_NAME_LEN = 50;

/** Pre-filled for a brand-new exam so admins have a starting point — all of it is editable. */
export const DEFAULT_SECTIONS = ["Aptitude", "Reasoning", "English Grammar"];

export const tidyName   = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
export const sectionKey = (v) => tidyName(v).toLowerCase();

/** Distinct section names used by questions, in order of first appearance. */
export const sectionsFromQuestions = (questions = []) => {
  const seen = new Set();
  const out = [];
  questions.forEach((q) => {
    const name = tidyName(q.section);
    if (name && !seen.has(sectionKey(name))) { seen.add(sectionKey(name)); out.push(name); }
  });
  return out;
};

/** Canonical spelling of `value` within `sections`, or undefined when it isn't one of them. */
export const resolveSection = (value, sections) => {
  const k = sectionKey(value);
  return k ? sections.find((n) => sectionKey(n) === k) : undefined;
};

/** Error text for a proposed section name, or "" if fine. `ignoreIndex` = the row being renamed. */
export const validateSectionName = (name, sections, ignoreIndex = -1) => {
  const n = tidyName(name);
  if (!n) return "Enter a section name";
  if (n.length > MAX_SECTION_NAME_LEN) return `Keep it under ${MAX_SECTION_NAME_LEN} characters`;
  if (sections.some((s, i) => i !== ignoreIndex && sectionKey(s) === sectionKey(n))) return `"${n}" already exists`;
  if (ignoreIndex === -1 && sections.length >= MAX_SECTIONS) return `At most ${MAX_SECTIONS} sections`;
  return "";
};

/** Apply a SectionManager change ({ sections, rename? }) to the question list. */
export const applySectionChange = (questions, change) => {
  if (!change.rename) return questions;
  const { from, to } = change.rename;
  return questions.map((q) => (sectionKey(q.section) === sectionKey(from) ? { ...q, section: to } : q));
};

/** Stable sort so questions are saved grouped by section, in the admin's order (unsectioned last). */
export const sortBySection = (questions, sections) => {
  const rank = (q) => { const i = sections.findIndex((n) => sectionKey(n) === sectionKey(q.section)); return i === -1 ? sections.length : i; };
  return questions.map((q, i) => [q, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([q]) => q);
};

/** { Aptitude: 3, Reasoning: 0, ... } */
export const countBySection = (questions, sections) =>
  sections.reduce((acc, s) => ({ ...acc, [s]: questions.filter((q) => sectionKey(q.section) === sectionKey(s)).length }), {});

/** Question-id → error, used when part of a paper has sections and part does not. */
export const sectionErrors = (questions, sections = []) => {
  const e = {};
  if (questions.some((q) => q.section)) {
    questions.forEach((q) => {
      if (!q.section || !resolveSection(q.section, sections)) e[`q-${q.id}-section`] = "Choose a section";
    });
  }
  return e;
};
