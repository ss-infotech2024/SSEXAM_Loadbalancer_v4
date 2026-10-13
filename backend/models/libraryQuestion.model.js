// models/libraryQuestion.model.js
// Reusable question bank. Shared by every admin of a department; admins copy questions
// from here into exams (the exam keeps its own copy, so later library edits never change a live exam).
import mongoose from 'mongoose';
import crypto from 'crypto';

export const DIFFICULTIES      = ['easy', 'medium', 'hard'];
export const SOURCES           = ['manual', 'ai', 'exam'];
export const MAX_TOPIC_LEN     = 100;

// Normalised fingerprint of the question text, used to stop the same question being stored twice.
export const hashQuestionText = (text) =>
  crypto.createHash('sha1')
    .update(String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .digest('hex');

const libraryQuestionSchema = new mongoose.Schema({
  department:    { type: String, required: true, index: true },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  text:          { type: String, required: true, trim: true, maxlength: 2000 },
  options:       { type: [String], required: true, validate: (v) => v.length === 4 },
  correctAnswer: { type: Number, required: true, min: 0, max: 3 },
  explanation:   { type: String, trim: true, maxlength: 1000, default: '' },   // admin-only, never sent to students

  topic:         { type: String, trim: true, maxlength: MAX_TOPIC_LEN, default: '' },
  difficulty:    { type: String, enum: DIFFICULTIES, default: 'medium' },
  source:        { type: String, enum: SOURCES, default: 'manual' },

  textHash:      { type: String, required: true },
}, { timestamps: true });

libraryQuestionSchema.index({ department: 1, textHash: 1 }, { unique: true });
libraryQuestionSchema.index({ department: 1, topic: 1, difficulty: 1 });

const LibraryQuestion = mongoose.model('LibraryQuestion', libraryQuestionSchema);
export default LibraryQuestion;
