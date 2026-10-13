// controllers/examController.js
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import xlsx from 'xlsx';
import { body, validationResult } from 'express-validator';
import Exam, { MAX_SECTIONS, MAX_SECTION_NAME_LEN } from '../models/exam.model.js';
import User from '../models/user.models.js';
import ExamAttempt from '../models/examattempt.model.js';
import ExamSession from '../models/examSession.model.js';
import { generateQuestions, isAiConfigured, AiError, AI_MAX_QUESTIONS } from '../services/aiQuestionService.js';

// A live session that hasn't sent a heartbeat for this long is treated as gone
const LIVE_TIMEOUT_MS = 90 * 1000;

// Deterministic shuffle seeded by exam + student — a student who reloads
// gets the same order, but each student gets a different one.
const seededShuffle = (items, seedText) => {
  let seed = 0;
  for (const ch of seedText) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  const rand = () => {                       // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ── ES Module __dirname fix (required for path.resolve to work) ───────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Helpers ───────────────────────────────────────────────────────────────────
const firstError = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return false;
  }
  return true;
};

const getAdminDept = async (req, res) => {
  const admin = await User.findById(req.user._id || req.user.id).select('department role').lean();
  if (!admin)            { res.status(401).json({ message: 'Admin not found' }); return null; }
  if (!admin.department) { res.status(400).json({ message: 'Admin has no department assigned' }); return null; }
  return admin.department;
};

// ── Shape helpers ─────────────────────────────────────────────────────────────
const computeStatus = (exam) => {
  const now = new Date();
  if (now < exam.startTime) return 'upcoming';
  if (now >= exam.startTime && now <= exam.endTime) return 'active';
  return 'completed';
};

// An AI exam that hasn't generated yet still advertises how many questions it will have.
const aiPartsTotal = (exam) => (exam.aiConfig?.parts || []).reduce((n, p) => n + (p.count || 0), 0);
const questionTotal = (exam) =>
  exam.questions?.length ? exam.questions.length : (exam.aiConfig?.enabled ? aiPartsTotal(exam) : 0);

const shapeExam = (exam) => ({
  _id:              exam._id,
  subject:          exam.subject,
  duration:         exam.duration,
  startTime:        exam.startTime,
  endTime:          exam.endTime,
  department:       exam.department,
  status:           computeStatus(exam),
  questionCount:    questionTotal(exam),
  marksPerQuestion: exam.marksPerQuestion ?? 1,
  totalMarks:       questionTotal(exam) * (exam.marksPerQuestion ?? 1),
  aiConfig:         exam.aiConfig?.enabled ? {
    enabled: true,
    parts: (exam.aiConfig.parts || []).map((p) => ({ topic: p.topic, count: p.count, difficulty: p.difficulty })),
    language: exam.aiConfig.language,
    status: exam.aiConfig.status, error: exam.aiConfig.error || null,
  } : { enabled: false },
  cameraEnabled:    exam.cameraEnabled ?? true,
  shuffleQuestions: exam.shuffleQuestions ?? false,
  createdAt:        exam.createdAt,
  createdBy:        exam.createdBy,
});

const shapeExamFull = (exam) => ({
  ...shapeExam(exam),
  sections: examSections(exam),
  questions: exam.questions.map((q) => ({
    _id:           q._id,
    text:          q.text,
    options:       q.options,
    correctAnswer: q.correctAnswer,
    section:       q.section || null,
  })),
});

// ── Sections ────────────────────────────────────────────────────────────────
// Sections are defined by the admin per exam (exam.sections, in display order).
// A question's `section` must be one of them; a question with none is "unsectioned".

const sectionKey = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const tidyName   = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

// Validate/normalise an admin-supplied list: trims, collapses spaces, drops blanks,
// removes case-insensitive duplicates. Returns { sections } or { error }.
const parseSectionList = (raw) => {
  if (!Array.isArray(raw)) return { error: 'sections must be an array of names' };
  const seen = new Set();
  const sections = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'Each section name must be text' };
    const name = tidyName(item);
    if (!name) continue;
    if (name.length > MAX_SECTION_NAME_LEN)
      return { error: `Section name "${name.slice(0, 20)}…" is too long (max ${MAX_SECTION_NAME_LEN} characters)` };
    const key = sectionKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(name);
  }
  if (sections.length > MAX_SECTIONS) return { error: `An exam can have at most ${MAX_SECTIONS} sections` };
  return { sections };
};

// Distinct section names used by questions, in order of first appearance.
const sectionsFromQuestions = (qs = []) => {
  const seen = new Set();
  const out  = [];
  qs.forEach((q) => {
    const name = tidyName(q.section);
    if (name && !seen.has(sectionKey(name))) { seen.add(sectionKey(name)); out.push(name); }
  });
  return out;
};

// The exam's configured sections; exams saved before this field existed fall back to
// whatever their questions already use.
const examSections = (exam) => (exam.sections?.length ? [...exam.sections] : sectionsFromQuestions(exam.questions));

// Sections actually containing questions (what students and exports show), in exam order.
const usedSections = (exam) => {
  const used = new Set((exam.questions || []).map((q) => sectionKey(q.section)));
  return examSections(exam).filter((n) => used.has(sectionKey(n)));
};

// Canonical spelling of a question's section within `sections`, or undefined.
const resolveSection = (v, sections) => {
  const key = sectionKey(v);
  return key ? sections.find((n) => sectionKey(n) === key) : undefined;
};

// Returns an error message when a question's section isn't one of the exam's, otherwise null.
// A missing section is allowed (unsectioned paper); an unknown one is not.
const sectionError = (q, i, sections) =>
  sectionKey(q.section) && !resolveSection(q.section, sections)
    ? `Question ${i + 1}: section "${tidyName(q.section)}" is not one of this exam's sections${sections.length ? ` (${sections.join(', ')})` : ''}`
    : null;

// Keep questions grouped by section (stable; unsectioned last) so students see each section together.
const sortBySection = (qs, sections) => {
  const rank = (q) => { const i = sections.findIndex((n) => sectionKey(n) === sectionKey(q.section)); return i === -1 ? sections.length : i; };
  return qs.map((q, i) => [q, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([q]) => q);
};

// Per-section summary of an attempt, in the exam's section order (sections not in the
// list — e.g. renamed since the attempt — follow in first-seen order). Empty for old
// attempts / unsectioned exams so callers can simply hide the breakdown.
const buildSectionBreakdown = (answers = [], marksPerQuestion = 1, order = []) => {
  const map = new Map();
  answers.forEach((a) => {
    if (!a.section) return;
    const row = map.get(a.section) || { section: a.section, totalQuestions: 0, correctCount: 0, wrongCount: 0, skippedCount: 0, score: 0, totalMarks: 0 };
    row.totalQuestions++;
    row.totalMarks += marksPerQuestion;
    if (a.isCorrect) { row.correctCount++; row.score += a.marksObtained ?? marksPerQuestion; }
    else if (a.userAnswer === -1) row.skippedCount++;
    else row.wrongCount++;
    map.set(a.section, row);
  });
  const names = [...order.filter((n) => map.has(n)), ...[...map.keys()].filter((n) => !order.includes(n))];
  return names.map((n) => {
    const r = map.get(n);
    return { ...r, percentage: r.totalMarks ? parseFloat(((r.score / r.totalMarks) * 100).toFixed(2)) : 0 };
  });
};

// =============================================================================
// GET /api/admin/exams
// =============================================================================
export const getExams = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;
    const exams = await Exam.find({ department: adminDept }).sort({ startTime: -1 }).lean();
    res.status(200).json({ exams: exams.map(shapeExam), total: exams.length });
  } catch (err) {
    console.error('getExams:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// GET /api/admin/exams/:id
// =============================================================================
export const getExamById = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;
    const exam = await Exam.findOne({ _id: req.params.id, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });
    res.status(200).json({ exam: shapeExamFull(exam) });
  } catch (err) {
    console.error('getExamById:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// POST /api/admin/exams
// =============================================================================
// ── AI paper generation ───────────────────────────────────────────────────────
const GENERATING_STALE_MS = 3 * 60 * 1000;   // a crashed worker must not block the exam forever
const AI_DIFFICULTIES = ['easy', 'medium', 'hard'];

const AI_MAX_PARTS = 8;
const AI_MAX_TOTAL = 60;

// Validates the admin-supplied aiConfig: { enabled, language, parts: [{ topic, count, difficulty }] }.
// Each part (topic) becomes its own section. Returns { value } or { error }.
const parseAiConfig = (raw) => {
  if (!raw || raw.enabled !== true) return { value: { enabled: false } };
  const language = String(raw.language ?? 'English').trim() || 'English';
  if (language.length > 30) return { error: 'Invalid language' };
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) return { error: 'Add at least one topic' };
  if (raw.parts.length > AI_MAX_PARTS) return { error: `At most ${AI_MAX_PARTS} topics are allowed` };

  const seen = new Set(), parts = [];
  let total = 0;
  for (const [i, p] of raw.parts.entries()) {
    const topic = tidyName(p?.topic);
    const count = parseInt(p?.count, 10);
    const difficulty = p?.difficulty ?? 'medium';
    if (!topic)                                  return { error: `Topic ${i + 1}: enter a topic` };
    if (topic.length > MAX_SECTION_NAME_LEN)     return { error: `Topic ${i + 1}: too long (max ${MAX_SECTION_NAME_LEN} characters)` };
    if (!AI_DIFFICULTIES.includes(difficulty))   return { error: `Topic ${i + 1}: invalid difficulty` };
    if (!(count >= 1 && count <= AI_MAX_QUESTIONS)) return { error: `Topic ${i + 1}: choose 1–${AI_MAX_QUESTIONS} questions` };
    const key = sectionKey(topic);
    if (seen.has(key))                           return { error: `Topic "${topic}" is listed twice` };
    seen.add(key);
    total += count;
    parts.push({ topic, count, difficulty });
  }
  if (total > AI_MAX_TOTAL) return { error: `At most ${AI_MAX_TOTAL} AI questions per exam (you asked for ${total})` };
  return { value: { enabled: true, parts, language, status: 'idle' } };
};

/**
 * Generate the paper for an AI exam exactly once, even if many students open it at the same moment.
 * Resolves to 'ready' | 'generating' | 'failed'.
 */
const ensureAiQuestions = async (examId, { force = false } = {}) => {
  const stale = new Date(Date.now() - GENERATING_STALE_MS);
  const claim = await Exam.findOneAndUpdate(
    {
      _id: examId, 'aiConfig.enabled': true,
      $or: [
        { 'aiConfig.status': { $in: ['idle', 'failed'] } },
        { 'aiConfig.status': 'generating', 'aiConfig.startedAt': { $lt: stale } },
        ...(force ? [{ 'aiConfig.status': 'ready' }] : []),
      ],
    },
    { $set: { 'aiConfig.status': 'generating', 'aiConfig.startedAt': new Date(), 'aiConfig.error': '' } },
    { new: true }
  );
  if (!claim) {
    const cur = await Exam.findById(examId).select('aiConfig questions').lean();
    if (cur?.aiConfig?.status === 'ready' && cur.questions?.length) return 'ready';
    return cur?.aiConfig?.status === 'failed' ? 'failed' : 'generating';
  }

  try {
    const { parts, language } = claim.aiConfig;
    // One AI call per topic, one after another (gentle on free-tier rate limits). All-or-nothing:
    // if any topic fails nothing is saved and the next request tries again.
    const questions = [];
    for (const part of parts) {
      const drafts = await generateQuestions({ topic: part.topic, difficulty: part.difficulty, count: part.count, language });
      if (drafts.length < part.count)
        throw new AiError(`The AI returned only ${drafts.length} of ${part.count} usable questions for "${part.topic}". Please try again.`, 503);
      drafts.forEach(d => questions.push({ section: part.topic, text: d.text, options: d.options, correctAnswer: d.correctAnswer }));
    }
    await Exam.updateOne({ _id: examId }, {
      $set: {
        questions,
        sections: parts.map(p => p.topic),
        'aiConfig.status': 'ready', 'aiConfig.error': '',
      },
    });
    return 'ready';
  } catch (err) {
    console.error('ensureAiQuestions:', err.message);
    await Exam.updateOne({ _id: examId }, {
      $set: { 'aiConfig.status': 'failed', 'aiConfig.error': (err instanceof AiError ? err.message : 'AI generation failed').slice(0, 300) },
    });
    return 'failed';
  }
};

// POST /api/admin/exams/:id/ai-generate  — admin generates (or regenerates) the paper early, to review it
export const generateExamQuestions = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;
    const exam = await Exam.findOne({ _id: req.params.id, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found' });
    if (!exam.aiConfig?.enabled) return res.status(400).json({ message: 'This exam is not set up for AI questions' });
    if (!isAiConfigured()) return res.status(503).json({ message: 'AI generation is not enabled on this server.' });
    if (new Date() >= exam.startTime) return res.status(400).json({ message: 'The exam has started; its questions can no longer be regenerated' });

    const status = await ensureAiQuestions(exam._id, { force: true });
    const fresh  = await Exam.findById(exam._id);
    if (status === 'failed') return res.status(503).json({ message: fresh.aiConfig.error || 'AI generation failed. Try again.' });
    if (status === 'generating') return res.status(409).json({ message: 'Questions are already being generated. Try again in a moment.' });
    res.status(200).json({ message: `Generated ${fresh.questions.length} questions`, exam: shapeExamFull(fresh) });
  } catch (err) {
    console.error('generateExamQuestions:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createExam = [
  body('subject').trim().notEmpty().withMessage('Subject name is required'),
  body('duration').isInt({ min: 1 }).withMessage('Duration must be a positive number of minutes'),
  body('startTime').notEmpty().isISO8601().withMessage('Valid start time is required'),
  body('endTime').notEmpty().isISO8601().withMessage('Valid end time is required'),
  body('marksPerQuestion').isInt({ min: 1, max: 10 }).withMessage('Marks per question must be between 1 and 10'),
  body('cameraEnabled').optional().isBoolean().withMessage('cameraEnabled must be true or false').toBoolean(true),
  body('shuffleQuestions').optional().isBoolean().withMessage('shuffleQuestions must be true or false').toBoolean(true),
  body('questions').optional().isArray().withMessage('Questions must be an array'),
  body('sections').optional().isArray().withMessage('Sections must be an array'),
  body('questions.*.text').if(body('questions').exists()).trim().notEmpty().withMessage('Each question must have text'),
  body('questions.*.options').if(body('questions').exists()).isArray({ min: 4, max: 4 }).withMessage('Each question must have exactly 4 options'),
  body('questions.*.correctAnswer').if(body('questions').exists()).isInt({ min: 0, max: 3 }).withMessage('Correct answer must be 0–3'),

  async (req, res) => {
    if (!firstError(req, res)) return;
    try {
      const adminDept = await getAdminDept(req, res);
      if (!adminDept) return;

      const { subject, duration, startTime, endTime, marksPerQuestion, cameraEnabled, shuffleQuestions, questions = [] } = req.body;

      if (new Date(endTime) <= new Date(startTime))
        return res.status(400).json({ message: 'End time must be after start time' });

      const ai = parseAiConfig(req.body.aiConfig);
      if (ai.error) return res.status(400).json({ message: ai.error });
      if (ai.value.enabled) {
        if (!isAiConfigured()) return res.status(503).json({ message: 'AI generation is not enabled on this server.' });
        if (questions.length) return res.status(400).json({ message: 'An AI exam creates its own questions; do not send any' });
      }

      // Admin-defined sections. If the client sent none, use whatever the questions name.
      const parsedSections = req.body.sections === undefined
        ? { sections: sectionsFromQuestions(questions) }
        : parseSectionList(req.body.sections);
      if (parsedSections.error) return res.status(400).json({ message: parsedSections.error });
      const sections = ai.value.enabled ? ai.value.parts.map(p => p.topic) : parsedSections.sections;

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.text?.trim())
          return res.status(400).json({ message: `Question ${i + 1}: text is required` });
        if (!Array.isArray(q.options) || q.options.length !== 4)
          return res.status(400).json({ message: `Question ${i + 1}: must have exactly 4 options` });
        if (q.options.some(o => !String(o).trim()))
          return res.status(400).json({ message: `Question ${i + 1}: all options must be non-empty` });
        if (q.correctAnswer == null || q.correctAnswer < 0 || q.correctAnswer > 3)
          return res.status(400).json({ message: `Question ${i + 1}: correctAnswer must be 0–3` });
        const secErr = sectionError(q, i, sections);
        if (secErr) return res.status(400).json({ message: secErr });
      }

      const exam = await Exam.create({
        subject:          subject.trim(),
        duration:         Number(duration),
        startTime:        new Date(startTime),
        endTime:          new Date(endTime),
        department:       adminDept,
        createdBy:        req.user._id || req.user.id,
        marksPerQuestion: Number(marksPerQuestion),
        cameraEnabled:    typeof cameraEnabled === 'boolean' ? cameraEnabled : true,
        shuffleQuestions: shuffleQuestions === true,
        sections,
        ...(ai.value.enabled ? { aiConfig: ai.value } : {}),
        questions:        sortBySection(questions, sections).map(q => ({
          section:       resolveSection(q.section, sections),
          text:          q.text.trim(),
          options:       q.options.map(o => String(o).trim()),
          correctAnswer: Number(q.correctAnswer),
        })),
      });

      res.status(201).json({
        message: `Exam "${exam.subject}" created successfully`,
        exam:    shapeExamFull(exam),
      });
    } catch (err) {
      console.error('createExam:', err);
      if (err.name === 'ValidationError') {
        const msg = Object.values(err.errors).map(e => e.message).join(', ');
        return res.status(400).json({ message: msg });
      }
      res.status(500).json({ message: 'Server error' });
    }
  },
];

// =============================================================================
// PUT /api/admin/exams/:id
// =============================================================================
export const updateExam = [
  body('subject').optional().trim().notEmpty().withMessage('Subject cannot be empty'),
  body('duration').optional().isInt({ min: 1 }).withMessage('Duration must be positive'),
  body('startTime').optional().isISO8601().withMessage('Invalid start time'),
  body('endTime').optional().isISO8601().withMessage('Invalid end time'),
  body('cameraEnabled').optional().isBoolean().withMessage('cameraEnabled must be true or false').toBoolean(true),
  body('shuffleQuestions').optional().isBoolean().withMessage('shuffleQuestions must be true or false').toBoolean(true),
  body('questions').optional().isArray().withMessage('Questions must be an array'),
  body('sections').optional().isArray().withMessage('Sections must be an array'),

  async (req, res) => {
    if (!firstError(req, res)) return;
    try {
      const adminDept = await getAdminDept(req, res);
      if (!adminDept) return;

      const exam = await Exam.findOne({ _id: req.params.id, department: adminDept });
      if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

      const { subject, duration, startTime, endTime, cameraEnabled, shuffleQuestions, questions } = req.body;

      if (subject)   exam.subject   = subject.trim();
      if (duration)  exam.duration  = Number(duration);
      if (startTime) exam.startTime = new Date(startTime);
      if (endTime)   exam.endTime   = new Date(endTime);
      // explicit type check — `if (cameraEnabled)` would silently drop `false`
      if (typeof cameraEnabled === 'boolean') exam.cameraEnabled = cameraEnabled;
      if (typeof shuffleQuestions === 'boolean') exam.shuffleQuestions = shuffleQuestions;

      if (exam.endTime <= exam.startTime)
        return res.status(400).json({ message: 'End time must be after start time' });

      // Section list the questions are validated against: the one sent, else the exam's current one.
      let sections = examSections(exam);
      if (req.body.sections !== undefined) {
        const parsedSections = parseSectionList(req.body.sections);
        if (parsedSections.error) return res.status(400).json({ message: parsedSections.error });
        sections = parsedSections.sections;
      }

      // Sections changed but questions weren't resent: the saved questions must still fit.
      if (req.body.sections !== undefined && !Array.isArray(questions)) {
        const orphan = exam.questions.find((q) => sectionKey(q.section) && !resolveSection(q.section, sections));
        if (orphan) return res.status(400).json({ message: `Section "${orphan.section}" still has questions — move them before removing it` });
        exam.questions.forEach((q) => { q.section = resolveSection(q.section, sections); });
      }

      if (Array.isArray(questions)) {
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          if (!q.text?.trim())
            return res.status(400).json({ message: `Question ${i + 1}: text is required` });
          if (!Array.isArray(q.options) || q.options.length !== 4)
            return res.status(400).json({ message: `Question ${i + 1}: must have exactly 4 options` });
          if (q.options.some(o => !String(o).trim()))
            return res.status(400).json({ message: `Question ${i + 1}: all options must be non-empty` });
          if (q.correctAnswer == null || q.correctAnswer < 0 || q.correctAnswer > 3)
            return res.status(400).json({ message: `Question ${i + 1}: correctAnswer must be 0–3` });
          const secErr = sectionError(q, i, sections);
          if (secErr) return res.status(400).json({ message: secErr });
        }
        exam.questions = sortBySection(questions, sections).map(q => ({
          section:       resolveSection(q.section, sections),
          text:          q.text.trim(),
          options:       q.options.map(o => String(o).trim()),
          correctAnswer: Number(q.correctAnswer),
        }));
      }

      exam.sections = sections;
      await exam.save();
      res.status(200).json({ message: 'Exam updated successfully', exam: shapeExamFull(exam) });
    } catch (err) {
      console.error('updateExam:', err);
      if (err.name === 'ValidationError') {
        const msg = Object.values(err.errors).map(e => e.message).join(', ');
        return res.status(400).json({ message: msg });
      }
      res.status(500).json({ message: 'Server error' });
    }
  },
];

// =============================================================================
// DELETE /api/admin/exams/:id
// =============================================================================
export const deleteExam = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;
    const exam = await Exam.findOneAndDelete({ _id: req.params.id, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });
    res.status(200).json({ message: `Exam "${exam.subject}" deleted successfully`, _id: exam._id });
  } catch (err) {
    console.error('deleteExam:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// GET /api/admin/exams/template/download
// =============================================================================
export const downloadExamTemplate = (req, res) => {
  const templatePath = path.resolve(__dirname, '../static/DB.xlsx');

  console.log('[downloadExamTemplate] Resolved path:', templatePath);

  if (!fs.existsSync(templatePath)) {
    console.error('[downloadExamTemplate] File NOT found at:', templatePath);
    return res.status(404).json({
      message: 'Template file not found on server. Please contact the administrator.',
    });
  }

  res.setHeader('Content-Disposition', 'attachment; filename="exam_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.sendFile(templatePath);
};

// ── Excel "Questions" sheet → { questions, sections } ─────────────────────────
// Section names are whatever the admin types in the Section column (first-seen order).
// Returns { questions, sections } or { error: { message, errors? } } (send as a 400 body)
const parseQuestionsSheet = (workbook) => {
  if (!workbook.SheetNames.includes('Questions')) {
    return { error: { message: 'Sheet "Questions" not found. Please use the provided template without renaming sheets.' } };
  }

  const qSheet  = workbook.Sheets['Questions'];
  const rawRows = xlsx.utils.sheet_to_json(qSheet, {
    header: ['num', 'text', 'optA', 'optB', 'optC', 'optD', 'correct', 'section'],
    range:  1,
    defval: '',
  });

  const filledRows = rawRows.filter(
    (r) => String(r.text || '').trim() || String(r.optA || '').trim() || String(r.correct || '').trim()
  );

  if (filledRows.length === 0) {
    return { error: { message: 'No questions found in the "Questions" sheet. Please add at least one question.' } };
  }

  const answerMap      = { A: 0, B: 1, C: 2, D: 3 };
  const questions      = [];
  const questionErrors = [];
  // Old templates have no Section column: if every row leaves it blank the paper is unsectioned.
  // Once any row has a section, every row must have one.
  const usesSections   = filledRows.some((r) => String(r.section || '').trim());
  const sections       = [];                 // canonical names, first-seen spelling wins
  const sectionByKey   = new Map();

  filledRows.forEach((row, i) => {
    const rowNum  = i + 2;
    const qText   = String(row.text    || '').trim();
    const optA    = String(row.optA    || '').trim();
    const optB    = String(row.optB    || '').trim();
    const optC    = String(row.optC    || '').trim();
    const optD    = String(row.optD    || '').trim();
    const correct = String(row.correct || '').trim().toUpperCase();

    if (!qText)  questionErrors.push(`Row ${rowNum}: Question text is required.`);
    if (!optA)   questionErrors.push(`Row ${rowNum}: Option A is required.`);
    if (!optB)   questionErrors.push(`Row ${rowNum}: Option B is required.`);
    if (!optC)   questionErrors.push(`Row ${rowNum}: Option C is required.`);
    if (!optD)   questionErrors.push(`Row ${rowNum}: Option D is required.`);
    if (!['A', 'B', 'C', 'D'].includes(correct))
      questionErrors.push(`Row ${rowNum}: Correct Answer must be A, B, C, or D (got "${row.correct}").`);

    const sectionRaw = tidyName(row.section);
    let section      = sectionByKey.get(sectionKey(sectionRaw));
    let sectionOk    = true;
    if (usesSections && !sectionRaw) {
      sectionOk = false;
      questionErrors.push(`Row ${rowNum}: Section is blank — fill it in for every row (or leave the whole column empty for no sections).`);
    } else if (sectionRaw.length > MAX_SECTION_NAME_LEN) {
      sectionOk = false;
      questionErrors.push(`Row ${rowNum}: Section name is too long (max ${MAX_SECTION_NAME_LEN} characters).`);
    } else if (sectionRaw && !section) {
      section = sectionRaw;
      sectionByKey.set(sectionKey(sectionRaw), sectionRaw);
      sections.push(sectionRaw);
    }

    if (qText && optA && optB && optC && optD && ['A', 'B', 'C', 'D'].includes(correct) && sectionOk) {
      questions.push({
        section:       usesSections ? section : undefined,
        text:          qText,
        options:       [optA, optB, optC, optD],
        correctAnswer: answerMap[correct],
      });
    }
  });

  if (sections.length > MAX_SECTIONS)
    questionErrors.push(`The sheet uses ${sections.length} different sections; an exam can have at most ${MAX_SECTIONS}.`);

  if (questionErrors.length)
    return { error: { message: 'Validation errors in the Questions sheet:', errors: questionErrors } };

  return { questions: sortBySection(questions, sections), sections };
};

// =============================================================================
// POST /api/admin/exams/questions/parse
// Reads only the "Questions" sheet and returns the questions WITHOUT saving —
// Edit Exam loads them into the editor and the admin saves as usual.
// =============================================================================
export const parseQuestionsExcel = (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No Excel file uploaded. Use field name "examFile".' });
  }

  let workbook;
  try {
    workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
  } catch {
    return res.status(400).json({ message: 'Invalid Excel file. Please use the provided template.' });
  }

  const parsed = parseQuestionsSheet(workbook);
  if (parsed.error) return res.status(400).json(parsed.error);

  res.status(200).json({ questions: parsed.questions, sections: parsed.sections, count: parsed.questions.length });
};

// =============================================================================
// POST /api/admin/exams/upload
// =============================================================================
export const uploadAndCreateExam = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No Excel file uploaded. Use field name "examFile".' });
    }

    // 1. Parse workbook
    let workbook;
    try {
      workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch {
      return res.status(400).json({ message: 'Invalid Excel file. Please use the provided template.' });
    }

    // 2. Read "Exam Info" sheet
    if (!workbook.SheetNames.includes('Exam Info')) {
      return res.status(400).json({
        message: 'Sheet "Exam Info" not found. Please use the provided template without renaming sheets.',
      });
    }

    const infoSheet = workbook.Sheets['Exam Info'];
    const getRaw = (sheet, row) => {
      const cell = sheet[xlsx.utils.encode_cell({ r: row - 1, c: 1 })];
      return cell ? cell.v : undefined;
    };

    const subject      = getRaw(infoSheet, 2);
    const durationRaw  = getRaw(infoSheet, 3);
    const startTimeRaw = getRaw(infoSheet, 4);
    const endTimeRaw   = getRaw(infoSheet, 5);
    const marksPerQRaw = getRaw(infoSheet, 6);

    const infoErrors = [];
    if (!subject || !String(subject).trim())
      infoErrors.push('"Subject" is required in the Exam Info sheet.');

    const duration = parseInt(durationRaw, 10);
    if (!durationRaw || isNaN(duration) || duration < 1)
      infoErrors.push('"Duration (minutes)" must be a positive integer in the Exam Info sheet.');

    let startTime, endTime;
    if (startTimeRaw instanceof Date)       startTime = startTimeRaw;
    else if (typeof startTimeRaw === 'string') startTime = new Date(startTimeRaw);
    if (!startTime || isNaN(startTime.getTime()))
      infoErrors.push('"Start Time" must be a valid date-time (e.g. 2025-08-01T10:00) in the Exam Info sheet.');

    if (endTimeRaw instanceof Date)         endTime = endTimeRaw;
    else if (typeof endTimeRaw === 'string')   endTime = new Date(endTimeRaw);
    if (!endTime || isNaN(endTime.getTime()))
      infoErrors.push('"End Time" must be a valid date-time (e.g. 2025-08-01T12:00) in the Exam Info sheet.');

    if (startTime && endTime && !isNaN(startTime) && !isNaN(endTime) && endTime <= startTime)
      infoErrors.push('"End Time" must be after "Start Time".');

    const marksPerQuestion = parseInt(marksPerQRaw, 10);
    if (!marksPerQRaw || isNaN(marksPerQuestion) || marksPerQuestion < 1 || marksPerQuestion > 10)
      infoErrors.push('"Marks Per Question" must be an integer between 1 and 10 in the Exam Info sheet.');

    if (infoErrors.length)
      return res.status(400).json({ message: infoErrors.join(' | ') });

    // 3. Read "Questions" sheet
    const parsed = parseQuestionsSheet(workbook);
    if (parsed.error) return res.status(400).json(parsed.error);
    const { questions, sections } = parsed;

    // 4. Admin department
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    // 5. Create exam
    const exam = await Exam.create({
      subject:          String(subject).trim(),
      duration,
      startTime,
      endTime,
      department:       adminDept,
      createdBy:        req.user._id || req.user.id,
      marksPerQuestion,
      sections,
      questions,   // already grouped by section by parseQuestionsSheet
    });

    if (req.file.path) fs.unlink(req.file.path, () => {});

    return res.status(201).json({
      message: `Exam "${exam.subject}" created successfully from Excel with ${questions.length} question(s).`,
      exam: {
        _id:              exam._id,
        subject:          exam.subject,
        duration:         exam.duration,
        startTime:        exam.startTime,
        endTime:          exam.endTime,
        department:       exam.department,
        marksPerQuestion: exam.marksPerQuestion,
        questionCount:    exam.questions.length,
        totalMarks:       exam.questions.length * exam.marksPerQuestion,
        createdAt:        exam.createdAt,
      },
    });
  } catch (err) {
    console.error('uploadAndCreateExam:', err);
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map((e) => e.message).join(', ');
      return res.status(400).json({ message: msg });
    }
    return res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/student/exams
// =============================================================================
export const getStudentExams = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id).select('department role').lean();
    if (!student || student.role !== 'student')
      return res.status(403).json({ message: 'Access denied' });
    const exams = await Exam.find({ department: student.department }).sort({ startTime: -1 }).lean();
    res.status(200).json({ exams: exams.map(shapeExam), total: exams.length });
  } catch (err) {
    console.error('getStudentExams:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// GET /api/student/exams/:id
// =============================================================================
export const getStudentExamById = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id).select('department role').lean();
    if (!student || student.role !== 'student')
      return res.status(403).json({ message: 'Access denied' });

    let exam = await Exam.findOne({ _id: req.params.id, department: student.department });
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    const now = new Date();
    if (now < exam.startTime) return res.status(403).json({ message: 'This exam has not started yet' });
    if (now > exam.endTime)   return res.status(403).json({ message: 'This exam has already ended' });

    // AI exam whose paper hasn't been generated yet: build it now (once, for everyone).
    if (exam.aiConfig?.enabled && exam.questions.length === 0) {
      const status = await ensureAiQuestions(exam._id);
      if (status !== 'ready')
        return res.status(503).json({ message: status === 'failed'
          ? 'The questions could not be prepared. Please tell your admin.'
          : 'Your questions are being prepared. Please try again in a few seconds.', retry: status === 'generating' });
      exam = await Exam.findById(exam._id);
    }

    // Shuffle per student, but keep sections together: questions are shuffled
    // inside each section, and sections stay in the admin's order.
    const sectionOrder = usedSections(exam);
    let questions = exam.questions;
    if (exam.shuffleQuestions) {
      const seed = `${exam._id}:${student._id}`;
      questions = sectionOrder.length
        ? [...sectionOrder, undefined].flatMap(n =>
            seededShuffle(exam.questions.filter(q => (resolveSection(q.section, sectionOrder) || undefined) === n), `${seed}:${n}`))
        : seededShuffle(exam.questions, seed);
    }

    res.status(200).json({
      exam: {
        _id:              exam._id,
        subject:          exam.subject,
        duration:         exam.duration,
        startTime:        exam.startTime,
        endTime:          exam.endTime,
        marksPerQuestion: exam.marksPerQuestion,
        totalMarks:       exam.questions.length * exam.marksPerQuestion,
        cameraEnabled:    exam.cameraEnabled ?? true,
        sections:         sectionOrder,
        questions:        questions.map(q => ({
          _id:     q._id,
          section: q.section || null,
          text:    q.text,
          options: q.options,
        })),
      },
    });
  } catch (err) {
    console.error('getStudentExamById:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// POST /api/student/exams/:id/heartbeat
// Sent when the exam starts and every ~30s while it runs → "live now" for admins
// =============================================================================
export const examHeartbeat = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id).select('_id department role').lean();
    if (!student || student.role !== 'student')
      return res.status(403).json({ message: 'Access denied' });

    const exam = await Exam.findOne({ _id: req.params.id, department: student.department })
      .select('startTime endTime').lean();
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    const now = new Date();
    if (now < exam.startTime || now > exam.endTime)
      return res.status(200).json({ ok: false });

    const submitted = await ExamAttempt.exists({ examId: exam._id, studentId: student._id });
    if (submitted) return res.status(200).json({ ok: false, submitted: true });

    await ExamSession.updateOne(
      { examId: exam._id, studentId: student._id },
      {
        $set:         { lastSeenAt: now },
        $setOnInsert: { startedAt: now, department: student.department },
      },
      { upsert: true }
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(200).json({ ok: true }); // concurrent upsert race
    console.error('examHeartbeat:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// GET /api/admin/students/exam-activity
// Live sessions + submitted attempts for the admin's department,
// used by "All students" for exam / date filters and the "Live now" view
// =============================================================================
export const getStudentExamActivity = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const exams = await Exam.find({ department: adminDept })
      .select('_id subject startTime endTime').sort({ startTime: -1 }).lean();
    const examById = new Map(exams.map((e) => [String(e._id), e]));
    const examIds  = exams.map((e) => e._id);
    const now      = new Date();

    const [sessions, attempts] = await Promise.all([
      ExamSession.find({ department: adminDept, lastSeenAt: { $gte: new Date(now - LIVE_TIMEOUT_MS) } }).lean(),
      ExamAttempt.find({ examId: { $in: examIds } })
        .select('examId studentId startedAt submittedAt percentage grade terminated').lean(),
    ]);

    const live = sessions
      .filter((s) => {
        const exam = examById.get(String(s.examId));
        return exam && now <= exam.endTime;
      })
      .map((s) => ({
        studentId:  s.studentId,
        examId:     s.examId,
        subject:    examById.get(String(s.examId)).subject,
        endTime:    examById.get(String(s.examId)).endTime,
        startedAt:  s.startedAt,
        lastSeenAt: s.lastSeenAt,
      }));

    res.status(200).json({
      exams: exams.map((e) => ({ _id: e._id, subject: e.subject, startTime: e.startTime, endTime: e.endTime, status: computeStatus(e) })),
      live,
      attempts: attempts.map((a) => ({
        studentId:   a.studentId,
        examId:      a.examId,
        subject:     examById.get(String(a.examId))?.subject,
        startedAt:   a.startedAt,
        submittedAt: a.submittedAt,
        percentage:  a.percentage,
        grade:       a.grade,
        terminated:  a.terminated,
      })),
    });
  } catch (err) {
    console.error('getStudentExamActivity:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// POST /api/student/exams/:id/submit
// =============================================================================
export const submitExam = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id)
      .select('_id department role fullName email').lean();
    if (!student || student.role !== 'student')
      return res.status(403).json({ message: 'Access denied. Student login required.' });

    const exam = await Exam.findOne({ _id: req.params.id, department: student.department });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const now = new Date();
    if (now < exam.startTime) return res.status(403).json({ message: 'Exam has not started yet' });
    if (now > exam.endTime)   return res.status(403).json({ message: 'Exam has already ended' });

    const { answers, terminatedBy, terminationReason } = req.body;
    if (!answers)                    return res.status(400).json({ message: 'Answers are required' });
    if (!Array.isArray(answers))     return res.status(400).json({ message: 'Answers must be an array' });
    if (answers.length !== exam.questions.length)
      return res.status(400).json({ message: `Expected ${exam.questions.length} answers, received ${answers.length}` });

    const existingAttempt = await ExamAttempt.findOne({ examId: exam._id, studentId: student._id });
    if (existingAttempt) {
      let correctCount = 0, wrongCount = 0, unansweredCount = 0;
      existingAttempt.answers?.forEach(a => {
        if (a.isCorrect) correctCount++;
        else if (a.userAnswer === -1) unansweredCount++;
        else wrongCount++;
      });
      return res.status(409).json({
        message: 'You have already submitted this exam.',
        alreadySubmitted: true,
        score: existingAttempt.score,
        totalMarks: existingAttempt.totalMarks,
        percentage: existingAttempt.percentage,
        grade: existingAttempt.grade,
        correctCount, wrongCount, unansweredCount,
        sectionBreakdown: buildSectionBreakdown(existingAttempt.answers, exam.marksPerQuestion, examSections(exam)),
        submittedAt: existingAttempt.submittedAt,
      });
    }

    const readAnswer = (item) => {
      let userAnswer = -1;
      if (typeof item === 'number') userAnswer = item;
      else if (item && typeof item === 'object') userAnswer = item.selectedOption ?? item.userAnswer ?? -1;
      if (userAnswer !== -1 && (userAnswer < 0 || userAnswer > 3)) userAnswer = -1;
      return userAnswer;
    };

    // Match answers by questionId (question order may be shuffled per student).
    // Falls back to position only when every answer can't be matched by id.
    const answerById = new Map();
    answers.forEach((item) => {
      if (item && typeof item === 'object' && item.questionId) answerById.set(String(item.questionId), item);
    });
    const matchById = exam.questions.every((q) => answerById.has(String(q._id)));

    // Stored in the exam's original question order so result views stay consistent
    const formattedAnswers = exam.questions.map((question, index) => {
      const userAnswer = readAnswer(matchById ? answerById.get(String(question._id)) : answers[index]);

      const isCorrect    = userAnswer === question.correctAnswer;
      const marksObtained = isCorrect ? exam.marksPerQuestion : 0;
      return { questionId: question._id, section: question.section, userAnswer, isCorrect, marksObtained };
    });

    const score      = formattedAnswers.reduce((s, a) => s + a.marksObtained, 0);
    const totalMarks = exam.questions.length * exam.marksPerQuestion;
    const percentage = parseFloat(((score / totalMarks) * 100).toFixed(2));

    let grade = 'F';
    if (percentage >= 90) grade = 'A+';
    else if (percentage >= 80) grade = 'A';
    else if (percentage >= 70) grade = 'B+';
    else if (percentage >= 60) grade = 'B';
    else if (percentage >= 50) grade = 'C';
    else if (percentage >= 40) grade = 'D';

    let correctCount = 0, wrongCount = 0, unansweredCount = 0;
    formattedAnswers.forEach(a => {
      if (a.isCorrect) correctCount++;
      else if (a.userAnswer === -1) unansweredCount++;
      else wrongCount++;
    });

    const session = await ExamSession.findOne({ examId: exam._id, studentId: student._id }).select('startedAt').lean();

    const attempt = await ExamAttempt.create({
      examId: exam._id, studentId: student._id,
      answers: formattedAnswers, score, totalMarks, percentage, grade,
      status: 'completed', submittedAt: new Date(), startedAt: session?.startedAt || new Date(),
      terminated: !!terminatedBy, terminationReason: terminationReason || null,
    });

    await ExamSession.deleteOne({ examId: exam._id, studentId: student._id }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Exam submitted successfully',
      result:  { score, totalMarks, percentage, grade, correctCount, wrongCount, unansweredCount, submittedAt: attempt.submittedAt, sectionBreakdown: buildSectionBreakdown(formattedAnswers, exam.marksPerQuestion, examSections(exam)) },
    });
  } catch (err) {
    console.error('submitExam error:', err);
    if (err.code === 11000) {
      const existing = await ExamAttempt.findOne({ examId: req.params.id, studentId: req.user._id || req.user.id });
      if (existing) {
        let correctCount = 0, wrongCount = 0, unansweredCount = 0;
        existing.answers?.forEach(a => {
          if (a.isCorrect) correctCount++;
          else if (a.userAnswer === -1) unansweredCount++;
          else wrongCount++;
        });
        return res.status(409).json({ message: 'You have already submitted this exam.', alreadySubmitted: true, score: existing.score, totalMarks: existing.totalMarks, percentage: existing.percentage, grade: existing.grade, correctCount, wrongCount, unansweredCount, submittedAt: existing.submittedAt });
      }
      return res.status(409).json({ message: 'You have already submitted this exam.', alreadySubmitted: true });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/student/exams/:id/attempt-status
// =============================================================================
export const getAttemptStatus = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id).select('_id').lean();
    if (!student) return res.status(403).json({ message: 'Access denied' });

    const attempt = await ExamAttempt.findOne({ examId: req.params.id, studentId: student._id, status: 'completed' });
    if (!attempt) return res.status(200).json({ attempted: false });

    res.status(200).json({
      attempted: true,
      score:       attempt.score,
      totalMarks:  attempt.totalMarks,
      percentage:  attempt.percentage,
      grade:       attempt.grade,
      submittedAt: attempt.submittedAt,
    });
  } catch (err) {
    console.error('getAttemptStatus:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// =============================================================================
// GET /api/student/results
// =============================================================================
export const getStudentResults = async (req, res) => {
  try {
    const student = await User.findById(req.user._id || req.user.id).select('_id department role').lean();
    if (!student || student.role !== 'student')
      return res.status(403).json({ message: 'Access denied. Student only.' });

    const results = await ExamAttempt.find({ studentId: student._id, status: 'completed' })
      .populate('examId', 'subject department startTime endTime duration marksPerQuestion sections')
      .sort({ submittedAt: -1 }).lean();

    const formattedResults = results.map(result => {
      let correctCount = 0, wrongCount = 0, skippedCount = 0;
      result.answers?.forEach(a => {
        if (a.isCorrect) correctCount++;
        else if (a.userAnswer === -1) skippedCount++;
        else wrongCount++;
      });
      return {
        _id:              result._id,
        examId:           result.examId?._id,
        subject:          result.examId?.subject || 'Unknown Subject',
        department:       result.examId?.department,
        startTime:        result.examId?.startTime,
        endTime:          result.examId?.endTime,
        duration:         result.examId?.duration,
        marksPerQuestion: result.examId?.marksPerQuestion || 1,
        score:            result.score,
        totalMarks:       result.totalMarks,
        percentage:       result.percentage,
        grade:            result.grade,
        correctCount, wrongCount, skippedCount,
        sectionBreakdown: buildSectionBreakdown(result.answers, result.examId?.marksPerQuestion || 1, examSections(result.examId || {})),
        submittedAt:      result.submittedAt,
      };
    });

    res.status(200).json({ results: formattedResults, total: formattedResults.length });
  } catch (err) {
    console.error('getStudentResults:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/results
// =============================================================================
export const getAdminResults = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const exams   = await Exam.find({ department: adminDept }).select('_id subject department').lean();
    const examIds = exams.map(e => e._id);

    const attempts = await ExamAttempt.find({ examId: { $in: examIds }, status: 'completed' })
      .populate({ path: 'examId',    select: 'subject department duration marksPerQuestion startTime endTime sections' })
      .populate({ path: 'studentId', select: 'fullName email rollNumber studentId department' })
      .sort({ submittedAt: -1 }).lean();

    const formattedResults = attempts.map(attempt => {
      let correctCount = 0, wrongCount = 0, skippedCount = 0;
      attempt.answers?.forEach(a => {
        if (a.isCorrect) correctCount++;
        else if (a.userAnswer === -1) skippedCount++;
        else wrongCount++;
      });
      const studentName = attempt.studentId?.fullName || 'Unknown Student';
      const rollNumber  = attempt.studentId?.rollNumber ||
        (attempt.studentId?.studentId ? `${attempt.studentId?.department || ''}${attempt.studentId?.studentId}` : 'N/A');
      return {
        _id: attempt._id,
        exam: {
          _id: attempt.examId?._id || 'N/A', subject: attempt.examId?.subject || 'Unknown Subject',
          department: attempt.examId?.department || 'N/A', duration: attempt.examId?.duration || 0,
          marksPerQuestion: attempt.examId?.marksPerQuestion || 1,
          startTime: attempt.examId?.startTime, endTime: attempt.examId?.endTime,
        },
        student: {
          _id: attempt.studentId?._id || 'N/A', name: studentName, fullName: studentName,
          email: attempt.studentId?.email || 'N/A', rollNumber,
          studentId: attempt.studentId?.studentId || 'N/A', department: attempt.studentId?.department || 'N/A',
        },
        score: attempt.score || 0, totalMarks: attempt.totalMarks || 0,
        percentage: attempt.percentage || 0, grade: attempt.grade || 'F',
        correctCount, wrongCount, skippedCount,
        sectionBreakdown: buildSectionBreakdown(attempt.answers, attempt.examId?.marksPerQuestion || 1, examSections(attempt.examId || {})),
        submittedAt: attempt.submittedAt, startedAt: attempt.startedAt,
      };
    });

    const totalStudents = new Set(formattedResults.map(r => r.student._id)).size;
    const totalExams    = new Set(formattedResults.map(r => r.exam._id)).size;
    const averageScore  = formattedResults.length > 0
      ? Math.round(formattedResults.reduce((s, r) => s + r.percentage, 0) / formattedResults.length) : 0;
    const passCount     = formattedResults.filter(r => r.percentage >= 40).length;

    res.status(200).json({
      success: true,
      summary: {
        totalResults: formattedResults.length, totalStudents, totalExams, averageScore,
        passCount, failCount: formattedResults.length - passCount,
        passRate: formattedResults.length > 0 ? Math.round((passCount / formattedResults.length) * 100) : 0,
        highestScore: formattedResults.length > 0 ? Math.max(...formattedResults.map(r => r.percentage)) : 0,
        lowestScore:  formattedResults.length > 0 ? Math.min(...formattedResults.map(r => r.percentage)) : 0,
      },
      results: formattedResults,
    });
  } catch (err) {
    console.error('getAdminResults:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/results/exam/:examId
// =============================================================================
export const getExamResults = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const exam = await Exam.findOne({ _id: req.params.examId, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const attempts = await ExamAttempt.find({ examId: req.params.examId, status: 'completed' })
      .populate({ path: 'studentId', select: 'fullName email rollNumber studentId department' })
      .sort({ percentage: -1 }).lean();

    const formattedResults = attempts.map(attempt => {
      let correctCount = 0, wrongCount = 0, skippedCount = 0;
      attempt.answers?.forEach(a => {
        if (a.isCorrect) correctCount++;
        else if (a.userAnswer === -1) skippedCount++;
        else wrongCount++;
      });
      const studentName = attempt.studentId?.fullName || 'Unknown Student';
      const rollNumber  = attempt.studentId?.rollNumber ||
        (attempt.studentId?.studentId ? `${attempt.studentId?.department || ''}${attempt.studentId?.studentId}` : 'N/A');
      return {
        _id: attempt._id,
        student: { _id: attempt.studentId?._id || 'N/A', name: studentName, fullName: studentName, email: attempt.studentId?.email || 'N/A', rollNumber, studentId: attempt.studentId?.studentId || 'N/A' },
        score: attempt.score || 0, totalMarks: attempt.totalMarks || 0,
        percentage: attempt.percentage || 0, grade: attempt.grade || 'F',
        correctCount, wrongCount, skippedCount, submittedAt: attempt.submittedAt,
        sectionBreakdown: buildSectionBreakdown(attempt.answers, exam.marksPerQuestion, examSections(exam)),
      };
    });

    const totalStudents = formattedResults.length;
    const averageScore  = totalStudents > 0 ? Math.round(formattedResults.reduce((s, r) => s + r.percentage, 0) / totalStudents) : 0;
    const passCount     = formattedResults.filter(r => r.percentage >= 40).length;

    res.status(200).json({
      success: true,
      exam: { _id: exam._id, subject: exam.subject, department: exam.department, duration: exam.duration, marksPerQuestion: exam.marksPerQuestion, sections: usedSections(exam), totalQuestions: exam.questions.length, totalMarks: exam.questions.length * exam.marksPerQuestion, startTime: exam.startTime, endTime: exam.endTime },
      summary: { totalStudents, averageScore, passCount, failCount: totalStudents - passCount, passRate: totalStudents > 0 ? Math.round((passCount / totalStudents) * 100) : 0, highestScore: totalStudents > 0 ? Math.max(...formattedResults.map(r => r.percentage)) : 0, lowestScore: totalStudents > 0 ? Math.min(...formattedResults.map(r => r.percentage)) : 0 },
      results: formattedResults,
    });
  } catch (err) {
    console.error('getExamResults:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/results/student/:studentId
// =============================================================================
export const getStudentResultsByAdmin = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const student = await User.findOne({ _id: req.params.studentId, role: 'student', department: adminDept })
      .select('fullName email rollNumber studentId department');
    if (!student) return res.status(404).json({ message: 'Student not found or not in your department' });

    const attempts = await ExamAttempt.find({ studentId: req.params.studentId, status: 'completed' })
      .populate('examId', 'subject department duration marksPerQuestion startTime endTime sections')
      .sort({ submittedAt: -1 }).lean();

    const formattedResults = attempts.map(attempt => {
      let correctCount = 0, wrongCount = 0, skippedCount = 0;
      attempt.answers?.forEach(a => {
        if (a.isCorrect) correctCount++;
        else if (a.userAnswer === -1) skippedCount++;
        else wrongCount++;
      });
      return {
        _id: attempt._id,
        exam: { _id: attempt.examId._id, subject: attempt.examId.subject, department: attempt.examId.department, duration: attempt.examId.duration, marksPerQuestion: attempt.examId.marksPerQuestion, startTime: attempt.examId.startTime, endTime: attempt.examId.endTime },
        score: attempt.score, totalMarks: attempt.totalMarks, percentage: attempt.percentage, grade: attempt.grade,
        correctCount, wrongCount, skippedCount, submittedAt: attempt.submittedAt,
        sectionBreakdown: buildSectionBreakdown(attempt.answers, attempt.examId.marksPerQuestion || 1, examSections(attempt.examId)),
      };
    });

    const totalExams          = formattedResults.length;
    const averagePercentage   = totalExams > 0 ? Math.round(formattedResults.reduce((s, r) => s + r.percentage, 0) / totalExams) : 0;
    const bestScore           = totalExams > 0 ? Math.max(...formattedResults.map(r => r.percentage)) : 0;
    const rollNumber          = student.rollNumber || `${student.department}${student.studentId}`;

    res.status(200).json({
      success: true,
      student: { _id: student._id, name: student.fullName, fullName: student.fullName, email: student.email, rollNumber, studentId: student.studentId, department: student.department },
      summary: { totalExams, averagePercentage, bestScore, passedExams: formattedResults.filter(r => r.percentage >= 40).length, failedExams: formattedResults.filter(r => r.percentage < 40).length },
      results: formattedResults,
    });
  } catch (err) {
    console.error('getStudentResultsByAdmin:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/results/export/:examId
// =============================================================================
export const exportExamResults = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const exam = await Exam.findOne({ _id: req.params.examId, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const attempts = await ExamAttempt.find({ examId: req.params.examId, status: 'completed' })
      .populate('studentId', 'fullName email rollNumber').sort({ percentage: -1 }).lean();

    // Current sections, plus any names older attempts were scored under (e.g. before a rename)
    const csvSections = [...usedSections(exam)];
    attempts.forEach((a) => (a.answers || []).forEach((ans) => {
      if (ans.section && !csvSections.includes(ans.section)) csvSections.push(ans.section);
    }));
    const csvRows = [['Roll Number','Student Name','Email','Score','Total Marks','Percentage','Grade','Correct Answers','Wrong Answers','Skipped Questions',
      ...csvSections.map(n => `"${n.replace(/"/g, '""')} Score"`), 'Submitted At'].join(',')];

    for (const attempt of attempts) {
      let correctCount = 0, wrongCount = 0, skippedCount = 0;
      attempt.answers?.forEach(a => { if (a.isCorrect) correctCount++; else if (a.userAnswer === -1) skippedCount++; else wrongCount++; });
      csvRows.push([
        `"${attempt.studentId?.rollNumber || 'N/A'}"`, `"${attempt.studentId?.fullName || 'N/A'}"`, `"${attempt.studentId?.email || 'N/A'}"`,
        attempt.score, attempt.totalMarks, attempt.percentage, attempt.grade,
        correctCount, wrongCount, skippedCount,
        ...csvSections.map(n => {
          const sb = buildSectionBreakdown(attempt.answers, exam.marksPerQuestion, examSections(exam)).find(r => r.section === n);
          return sb ? `"${sb.score}/${sb.totalMarks}"` : '"-"';
        }),
        new Date(attempt.submittedAt).toLocaleString(),
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=exam_${exam.subject}_results_${Date.now()}.csv`);
    res.status(200).send(csvRows.join('\n'));
  } catch (err) {
    console.error('exportExamResults:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/exams/:examId/attendees/export
// =============================================================================
export const exportExamAttendees = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const exam = await Exam.findOne({ _id: req.params.examId, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const allStudents = await User.find({ role: 'student', department: adminDept, status: 'active' })
      .select('fullName email rollNumber studentId department');
    const attempts    = await ExamAttempt.find({ examId: req.params.examId, status: 'completed' })
      .select('studentId score percentage grade submittedAt');

    const attemptMap = new Map();
    attempts.forEach(a => attemptMap.set(a.studentId.toString(), a));

    const csvRows = [['Roll Number','Student Name','Email','Department','Status','Score','Total Marks','Percentage','Grade','Submitted At'].join(',')];
    const totalMarks = exam.questions.length * exam.marksPerQuestion;

    for (const student of allStudents) {
      const attempt    = attemptMap.get(student._id.toString());
      const rollNumber = student.rollNumber || `${student.department}${student.studentId}`;
      csvRows.push([
        `"${rollNumber}"`, `"${student.fullName}"`, `"${student.email}"`, `"${student.department}"`,
        attempt ? 'Attended' : 'Not Attended',
        attempt ? attempt.score : 0, totalMarks,
        attempt ? attempt.percentage : 0, attempt ? attempt.grade : 'N/A',
        attempt ? new Date(attempt.submittedAt).toLocaleString() : 'N/A',
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=exam_${exam.subject}_attendees_${Date.now()}.csv`);
    res.status(200).send(csvRows.join('\n'));
  } catch (err) {
    console.error('exportExamAttendees:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// GET /api/admin/exams/:examId/attendees
// =============================================================================
export const getExamAttendees = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const { examId } = req.params;
    if (!examId || examId === 'undefined' || examId === 'null')
      return res.status(400).json({ message: 'Invalid exam ID' });

    const exam = await Exam.findOne({ _id: examId, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const allStudents = await User.find({ role: 'student', department: adminDept })
      .select('fullName email rollNumber studentId department').lean();
    const attempts    = await ExamAttempt.find({ examId, status: 'completed' })
      .select('studentId score totalMarks percentage grade submittedAt correctCount wrongCount skippedCount').lean();

    const attemptMap = new Map();
    attempts.forEach(a => attemptMap.set(a.studentId.toString(), a));

    const attendedStudents    = [];
    const notAttendedStudents = [];

    for (const student of allStudents) {
      const attempt     = attemptMap.get(student._id.toString());
      const studentData = {
        _id: student._id,
        fullName:   student.fullName || 'Unknown Student',
        email:      student.email    || 'N/A',
        rollNumber: student.rollNumber || `${student.department || 'CS'}${student.studentId || ''}`,
        studentId:  student.studentId  || 'N/A',
        department: student.department,
      };
      if (attempt) {
        attendedStudents.push({ ...studentData, status: 'attended', score: attempt.score || 0, totalMarks: attempt.totalMarks || (exam.questions?.length * (exam.marksPerQuestion || 1)), percentage: attempt.percentage || 0, grade: attempt.grade || 'F', correctCount: attempt.correctCount || 0, wrongCount: attempt.wrongCount || 0, skippedCount: attempt.skippedCount || 0, submittedAt: attempt.submittedAt });
      } else {
        notAttendedStudents.push({ ...studentData, status: 'not_attended', score: 0, totalMarks: exam.questions?.length * (exam.marksPerQuestion || 1) || 0, percentage: 0, grade: 'N/A', correctCount: 0, wrongCount: 0, skippedCount: 0, submittedAt: null });
      }
    }

    const totalStudents   = allStudents.length;
    const attendedCount   = attendedStudents.length;
    const attendanceRate  = totalStudents > 0 ? ((attendedCount / totalStudents) * 100).toFixed(2) : 0;
    const averageScore    = attendedCount   > 0 ? (attendedStudents.reduce((s, st) => s + st.percentage, 0) / attendedCount).toFixed(2) : 0;
    const passCount       = attendedStudents.filter(s => s.percentage >= 40).length;

    res.status(200).json({
      success: true,
      exam: { _id: exam._id, subject: exam.subject, department: exam.department, duration: exam.duration, totalQuestions: exam.questions?.length || 0, totalMarks: exam.questions?.length * (exam.marksPerQuestion || 1), startTime: exam.startTime, endTime: exam.endTime },
      summary: { totalStudents, attendedCount, notAttendedCount: allStudents.length - attendedCount, attendanceRate: parseFloat(attendanceRate), averageScore: parseFloat(averageScore), passCount, passRate: attendedCount > 0 ? ((passCount / attendedCount) * 100).toFixed(2) : 0 },
      attendedStudents:    attendedStudents.sort((a, b) => b.percentage - a.percentage),
      notAttendedStudents,
    });
  } catch (err) {
    console.error('getExamAttendees error:', err);
    res.status(500).json({ message: 'Server error: ' + err.message });
  }
};

// =============================================================================
// DELETE /api/admin/exams/:examId/attempts/:studentId/reschedule
// =============================================================================
export const resetExamAttempt = async (req, res) => {
  try {
    const adminDept = await getAdminDept(req, res);
    if (!adminDept) return;

    const { examId, studentId } = req.params;

    const exam = await Exam.findOne({ _id: examId, department: adminDept });
    if (!exam) return res.status(404).json({ message: 'Exam not found or not in your department' });

    const student = await User.findOne({ _id: studentId, role: 'student', department: adminDept });
    if (!student) return res.status(404).json({ message: 'Student not found or not in your department' });

    const deletedAttempt = await ExamAttempt.findOneAndDelete({ examId, studentId });
    if (!deletedAttempt) return res.status(404).json({ message: 'No attempt found for this student on this exam' });

    res.status(200).json({
      success: true,
      message: `Exam attempt has been reset successfully for ${student.fullName || 'the student'}. They can now retake the exam.`,
      deletedAttemptId: deletedAttempt._id,
    });
  } catch (err) {
    console.error('resetExamAttempt error:', err);
    res.status(500).json({ message: 'Server error while resetting attempt: ' + err.message });
  }
};