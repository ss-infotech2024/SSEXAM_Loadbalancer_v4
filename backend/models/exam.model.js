// models/exam.model.js
import mongoose from 'mongoose';

// Sections are defined per exam by the admin (see `sections` on the exam below).
// A question's `section` is just the name of one of its exam's sections; exams
// created before sections existed have none (treated as one unsectioned paper).
export const MAX_SECTIONS        = 20;
export const MAX_SECTION_NAME_LEN = 50;

const questionSchema = new mongoose.Schema({
  section:       { type: String, trim: true, maxlength: MAX_SECTION_NAME_LEN },
  text:          { type: String, required: true, trim: true },
  options:       { type: [String], required: true, validate: (v) => v.length === 4 },
  correctAnswer: { type: Number, required: true, min: 0, max: 3 },
}, { _id: true });

const examSchema = new mongoose.Schema({
  subject: {
    type:     String,
    required: true,
    trim:     true,
  },
  duration: {
    type:     Number,
    required: true,
    min:      1,
  },
  startTime: {
    type:     Date,
    required: true,
  },
  endTime: {
    type:     Date,
    required: true,
  },
  department: {
    type:     String,
    enum:     ['Data Bricks', 'Service Now', 'MCA'],
    required: true,
  },
  createdBy: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  // ── Marks per question — set once at creation, fixed forever ──────────────
  marksPerQuestion: {
    type:     Number,
    required: true,
    min:      1,
    max:      10,
    default:  1,
  },

  // ── Camera proctoring — missing on old exams, treated as true ─────────────
  cameraEnabled: {
    type:    Boolean,
    default: true,
  },

  // ── Shuffle question order per student — missing on old exams, treated as false
  shuffleQuestions: {
    type:    Boolean,
    default: false,
  },

  // ── Admin-defined section names, in display order. Empty on old / unsectioned
  //    exams — use examSections() in the controller, which falls back to the
  //    names found on the questions.
  sections: {
    type:    [{ type: String, trim: true, maxlength: MAX_SECTION_NAME_LEN }],
    default: [],
  },

  questions: {
    type:    [questionSchema],
    default: [],
  },

  // ── AI-generated paper ────────────────────────────────────────────────────
  // When enabled the admin gives only a topic; the server asks the AI for the
  // questions ONCE (before the exam or when the first student opens it), saves
  // them into `questions`, and every student gets that same paper. Scoring is
  // unchanged: it compares answers with the correctAnswer saved at generation.
  aiConfig: {
    enabled:     { type: Boolean, default: false },
    // One entry per topic. Each topic becomes its own section holding `count` questions.
    parts: [{
      _id:        false,
      topic:      { type: String, trim: true, maxlength: 100, required: true },
      count:      { type: Number, min: 1, max: 20, required: true },
      difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    }],
    language:    { type: String, trim: true, maxlength: 30, default: 'English' },
    status:      { type: String, enum: ['idle', 'generating', 'ready', 'failed'], default: 'idle' },
    startedAt:   { type: Date },
    error:       { type: String, maxlength: 300 },
  },
  status: {
    type:    String,
    enum:    ['upcoming', 'active', 'completed'],
    default: 'upcoming',
  },
}, { timestamps: true });

examSchema.index({ department: 1, startTime: -1 });

const Exam = mongoose.model('Exam', examSchema);
export default Exam;