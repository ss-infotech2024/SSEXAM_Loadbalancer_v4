// controllers/questionLibraryController.js
// Question library: per-department bank of reusable MCQs, plus AI generation of new ones.
// Mount: app.use('/api/admin/question-library', questionLibraryRoutes)
import LibraryQuestion, { DIFFICULTIES, MAX_TOPIC_LEN, hashQuestionText } from '../models/libraryQuestion.model.js';
import User from '../models/user.models.js';
import { generateQuestions, isAiConfigured, AiError, AI_MAX_QUESTIONS } from '../services/aiQuestionService.js';

const MAX_BULK        = 200;
const MAX_PAGE_SIZE   = 100;

const getAdminDept = async (req, res) => {
  const admin = await User.findById(req.user._id || req.user.id).select('department role').lean();
  if (!admin)            { res.status(401).json({ message: 'Admin not found' }); return null; }
  if (!admin.department) { res.status(400).json({ message: 'Admin has no department assigned' }); return null; }
  return admin.department;
};

const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const shape = (q) => ({
  _id: q._id, text: q.text, options: q.options, correctAnswer: q.correctAnswer,
  explanation: q.explanation || '', topic: q.topic || '', difficulty: q.difficulty || 'medium',
  source: q.source || 'manual', createdAt: q.createdAt, updatedAt: q.updatedAt,
});

// Validates one incoming question. Returns { value } or { error }.
// `defaults` supplies topic/difficulty when the question doesn't carry its own.
const parseQuestion = (q, defaults = {}) => {
  if (!q || typeof q !== 'object') return { error: 'is not a valid question' };
  const text = String(q.text ?? '').trim();
  if (!text) return { error: 'text is required' };
  if (text.length > 2000) return { error: 'text is too long (max 2000 characters)' };
  if (!Array.isArray(q.options) || q.options.length !== 4) return { error: 'must have exactly 4 options' };
  const options = q.options.map((o) => String(o ?? '').trim());
  if (options.some((o) => !o)) return { error: 'all 4 options must be filled in' };
  const correctAnswer = Number(q.correctAnswer);
  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) return { error: 'correctAnswer must be 0–3' };

  const topic = tidy(q.topic ?? defaults.topic ?? '');
  if (topic.length > MAX_TOPIC_LEN) return { error: `topic is too long (max ${MAX_TOPIC_LEN} characters)` };
  const difficulty = q.difficulty ?? defaults.difficulty ?? 'medium';
  if (!DIFFICULTIES.includes(difficulty)) return { error: `difficulty must be one of ${DIFFICULTIES.join(', ')}` };
  const explanation = String(q.explanation ?? '').trim();
  if (explanation.length > 1000) return { error: 'explanation is too long (max 1000 characters)' };

  return { value: { text, options, correctAnswer, explanation, topic, difficulty } };
};

// ── GET /ai-status ───────────────────────────────────────────────────────────
export const getAiStatus = (_req, res) =>
  res.status(200).json({ enabled: isAiConfigured(), maxQuestions: AI_MAX_QUESTIONS });

// ── GET / ────────────────────────────────────────────────────────────────────
// ?search=&topic=&difficulty=&source=&page=1&limit=20
export const listQuestions = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;

    const { search = '', topic = '', difficulty = '', source = '' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = { department: dept };
    if (search)                       filter.text = { $regex: escapeRegex(String(search).slice(0, 100)), $options: 'i' };
    if (topic === '__none__')         filter.topic = '';
    else if (topic)                   filter.topic = String(topic);
    if (DIFFICULTIES.includes(difficulty)) filter.difficulty = difficulty;
    if (['manual', 'ai', 'exam'].includes(source)) filter.source = source;

    const [items, total] = await Promise.all([
      LibraryQuestion.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      LibraryQuestion.countDocuments(filter),
    ]);

    res.status(200).json({ questions: items.map(shape), total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
  } catch (err) {
    console.error('listQuestions:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /topics ──────────────────────────────────────────────────────────────
export const listTopics = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;
    const rows = await LibraryQuestion.aggregate([
      { $match: { department: dept } },
      { $group: { _id: '$topic', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.status(200).json({
      topics: rows.filter((r) => r._id).map((r) => ({ name: r._id, count: r.count })),
      uncategorised: rows.find((r) => !r._id)?.count ?? 0,
      total: rows.reduce((s, r) => s + r.count, 0),
    });
  } catch (err) {
    console.error('listTopics:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Inserts validated questions, skipping ones already in the library (same text) or repeated in the batch.
const insertQuestions = async ({ dept, userId, items, source }) => {
  const seen = new Set();
  const docs = [];
  let skipped = 0;
  for (const v of items) {
    const textHash = hashQuestionText(v.text);
    if (seen.has(textHash)) { skipped++; continue; }
    seen.add(textHash);
    docs.push({ ...v, textHash, department: dept, createdBy: userId, source });
  }
  if (docs.length) {
    const existing = await LibraryQuestion.find({ department: dept, textHash: { $in: docs.map((d) => d.textHash) } }).select('textHash').lean();
    const taken = new Set(existing.map((e) => e.textHash));
    skipped += docs.filter((d) => taken.has(d.textHash)).length;
    docs.splice(0, docs.length, ...docs.filter((d) => !taken.has(d.textHash)));
  }
  let inserted = [];
  if (docs.length) {
    try {
      inserted = await LibraryQuestion.insertMany(docs, { ordered: false });
    } catch (err) {
      if (err.code !== 11000 && !err.writeErrors) throw err;       // a concurrent duplicate — keep what went in
      inserted = err.insertedDocs || [];
      skipped += docs.length - inserted.length;
    }
  }
  return { added: inserted.length, skipped, items: inserted.map((d) => shape(d.toObject ? d.toObject() : d)) };
};

// ── POST / ───────────────────────────────────────────────────────────────────
export const createQuestion = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;
    const parsed = parseQuestion(req.body);
    if (parsed.error) return res.status(400).json({ message: `Question ${parsed.error}` });

    const result = await insertQuestions({ dept, userId: req.user._id || req.user.id, items: [parsed.value], source: 'manual' });
    if (result.added === 0) return res.status(409).json({ message: 'This question is already in the library.' });
    res.status(201).json({ message: 'Question added to the library', question: result.items[0] });
  } catch (err) {
    console.error('createQuestion:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /bulk ───────────────────────────────────────────────────────────────
// body: { questions: [...], topic?, difficulty?, source?: 'ai' | 'exam' | 'manual' }
export const bulkCreateQuestions = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;

    const { questions, topic, difficulty, source = 'manual' } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ message: 'No questions to add' });
    if (questions.length > MAX_BULK) return res.status(400).json({ message: `You can add at most ${MAX_BULK} questions at a time` });
    if (!['manual', 'ai', 'exam'].includes(source)) return res.status(400).json({ message: 'Invalid source' });

    const items = [];
    for (let i = 0; i < questions.length; i++) {
      const parsed = parseQuestion(questions[i], { topic, difficulty });
      if (parsed.error) return res.status(400).json({ message: `Question ${i + 1}: ${parsed.error}` });
      items.push(parsed.value);
    }

    const { added, skipped } = await insertQuestions({ dept, userId: req.user._id || req.user.id, items, source });
    const message = added === 0
      ? 'Nothing was added — these questions are already in the library.'
      : `Added ${added} question${added === 1 ? '' : 's'} to the library${skipped ? ` (${skipped} already there, skipped)` : ''}.`;
    res.status(added ? 201 : 200).json({ message, added, skipped });
  } catch (err) {
    console.error('bulkCreateQuestions:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── PUT /:id ─────────────────────────────────────────────────────────────────
export const updateQuestion = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;
    const q = await LibraryQuestion.findOne({ _id: req.params.id, department: dept });
    if (!q) return res.status(404).json({ message: 'Question not found' });

    const parsed = parseQuestion({ ...req.body, topic: req.body.topic ?? '', difficulty: req.body.difficulty ?? q.difficulty });
    if (parsed.error) return res.status(400).json({ message: `Question ${parsed.error}` });

    const textHash = hashQuestionText(parsed.value.text);
    if (textHash !== q.textHash && await LibraryQuestion.exists({ department: dept, textHash, _id: { $ne: q._id } }))
      return res.status(409).json({ message: 'Another question with this text is already in the library.' });

    Object.assign(q, parsed.value, { textHash });
    await q.save();
    res.status(200).json({ message: 'Question updated', question: shape(q.toObject()) });
  } catch (err) {
    console.error('updateQuestion:', err);
    if (err.name === 'CastError') return res.status(404).json({ message: 'Question not found' });
    res.status(500).json({ message: 'Server error' });
  }
};

// ── DELETE /:id ──────────────────────────────────────────────────────────────
export const deleteQuestion = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;
    const q = await LibraryQuestion.findOneAndDelete({ _id: req.params.id, department: dept });
    if (!q) return res.status(404).json({ message: 'Question not found' });
    res.status(200).json({ message: 'Question deleted', _id: q._id });
  } catch (err) {
    console.error('deleteQuestion:', err);
    if (err.name === 'CastError') return res.status(404).json({ message: 'Question not found' });
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /bulk-delete ────────────────────────────────────────────────────────
export const bulkDeleteQuestions = async (req, res) => {
  try {
    const dept = await getAdminDept(req, res);
    if (!dept) return;
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK || ids.some((id) => typeof id !== 'string'))
      return res.status(400).json({ message: `Send between 1 and ${MAX_BULK} question ids` });
    const r = await LibraryQuestion.deleteMany({ _id: { $in: ids }, department: dept });
    res.status(200).json({ message: `Deleted ${r.deletedCount} question${r.deletedCount === 1 ? '' : 's'}`, deleted: r.deletedCount });
  } catch (err) {
    console.error('bulkDeleteQuestions:', err);
    if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid question id' });
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /generate ───────────────────────────────────────────────────────────
// Returns DRAFTS only — nothing is saved until the admin reviews them and saves / uses them.
// Simple per-admin limit (in memory, per server process) so a stuck button can't burn the API budget.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX       = 10;
const hits = new Map();   // userId → [timestamps]
const rateLimited = (userId) => {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) { hits.set(userId, recent); return true; }
  recent.push(now);
  hits.set(userId, recent);
  return false;
};

export const generateQuestionDrafts = async (req, res) => {
  try {
    if (!isAiConfigured()) return res.status(503).json({ message: 'AI generation is not enabled on this server.' });
    const dept = await getAdminDept(req, res);
    if (!dept) return;

    const topic        = tidy(req.body.topic);
    const difficulty   = req.body.difficulty ?? 'medium';
    const count        = parseInt(req.body.count, 10) || 5;
    const instructions = String(req.body.instructions ?? '').trim();
    const language     = tidy(req.body.language) || 'English';

    if (!topic)                               return res.status(400).json({ message: 'Enter a topic' });
    if (topic.length > MAX_TOPIC_LEN)         return res.status(400).json({ message: `Topic is too long (max ${MAX_TOPIC_LEN} characters)` });
    if (!DIFFICULTIES.includes(difficulty))   return res.status(400).json({ message: 'Invalid difficulty' });
    if (count < 1 || count > AI_MAX_QUESTIONS) return res.status(400).json({ message: `Choose 1–${AI_MAX_QUESTIONS} questions` });
    if (instructions.length > 500)            return res.status(400).json({ message: 'Extra instructions are too long (max 500 characters)' });
    if (language.length > 30)                 return res.status(400).json({ message: 'Invalid language' });

    const userId = String(req.user._id || req.user.id);
    if (rateLimited(userId)) return res.status(429).json({ message: `You've generated a lot recently. Please wait a few minutes (limit: ${RATE_MAX} per ${RATE_WINDOW_MS / 60000} min).` });

    // Tell the model what the library already holds on this topic so it doesn't repeat itself
    const existing = await LibraryQuestion.find({ department: dept, topic: { $regex: `^${escapeRegex(topic)}$`, $options: 'i' } })
      .sort({ createdAt: -1 }).limit(30).select('text').lean();

    const drafts = await generateQuestions({ topic, difficulty, count, instructions, language, avoid: existing.map((e) => e.text.slice(0, 160)) });

    // Flag drafts that match something already stored (exact text after normalising)
    const hashes = drafts.map((d) => hashQuestionText(d.text));
    const dupes  = new Set((await LibraryQuestion.find({ department: dept, textHash: { $in: hashes } }).select('textHash').lean()).map((d) => d.textHash));

    res.status(200).json({
      questions: drafts.map((d, i) => ({ ...d, topic, difficulty, duplicate: dupes.has(hashes[i]) })),
      requested: count,
    });
  } catch (err) {
    if (err instanceof AiError) return res.status(err.status).json({ message: err.message });
    console.error('generateQuestionDrafts:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
