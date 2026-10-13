// models/examAttempt.model.js
import mongoose from 'mongoose';

const examAttemptSchema = new mongoose.Schema({
  examId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Exam',
    required: [true, 'Exam ID is required']
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Student ID is required']
  },
  answers: [{
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    // Copied from the question at submit time so section-wise results survive exam edits
    section: {
      type: String
    },
    userAnswer: {
      type: Number,
      required: true,
      default: -1
    },
    isCorrect: {
      type: Boolean,
      default: false
    },
    marksObtained: {
      type: Number,
      default: 0
    }
  }],
  score: {
    type: Number,
    required: true,
    default: 0
  },
  totalMarks: {
    type: Number,
    required: true,
    default: 0
  },
  percentage: {
    type: Number,
    required: true,
    default: 0
  },
  grade: {
    type: String,
    required: true,
    default: 'F',
    uppercase: true
  },
  status: {
    type: String,
    enum: ['in-progress', 'completed'],
    default: 'completed'
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  terminated: {
    type: Boolean,
    default: false
  },
  terminationReason: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// IMPORTANT: This unique index prevents duplicate submissions
examAttemptSchema.index({ examId: 1, studentId: 1 }, { unique: true });

// Additional indexes for faster queries
examAttemptSchema.index({ studentId: 1, submittedAt: -1 });
examAttemptSchema.index({ examId: 1, submittedAt: -1 });

const ExamAttempt = mongoose.model('ExamAttempt', examAttemptSchema);

export default ExamAttempt;