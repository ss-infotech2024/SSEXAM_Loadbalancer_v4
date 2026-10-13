// routes/adminRoutes.js


// Mount: app.use('/api/admin', adminRoutes)

import express from 'express';
import multer from 'multer';                          // npm install multer
import {
  getStudents,
  createStudent,
  bulkAddStudents,
  updateStudent,
  deleteStudent,
  changeStudentPassword,
  bulkChangeStudentPassword,
  downloadAllStudentsExcel,
} from '../controllers/adminController.js';
import {
  getExams,
  getExamById,
  generateExamQuestions,
  createExam,
  updateExam,
  deleteExam,
  getAdminResults,
  getExamResults,
  getStudentResultsByAdmin,
  exportExamResults,
  getExamAttendees,
  exportExamAttendees,
  resetExamAttempt,
  getStudentExamActivity,
} from '../controllers/examController.js';
import {
  downloadExamTemplate,
  uploadAndCreateExam,
  parseQuestionsExcel,
} from '../controllers/examController.js';      // ← your Excel controller
import {
  getExamAttempts,
  rescheduleAttempt,
} from '../controllers/examattemptcontroller.js';
import { protect, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// ── Multer — memory storage, .xlsx only, 5 MB cap ────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    ok
      ? cb(null, true)
      : cb(new Error('Only .xlsx files are accepted.'), false);
  },
});

// ── Multer error handler (catches file-type / size rejections) ───────────────
const handleUpload = (req, res, next) => {
  upload.single('examFile')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ message: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    next();
  });
};

router.use(protect, adminOnly);

// ── Students ──────────────────────────────────────────────────────────────────
router.get   ('/students',              getStudents);
router.post  ('/create-student',        createStudent);
router.post  ('/students/bulk',         bulkAddStudents);
router.get   ('/students/download-all',         downloadAllStudentsExcel);
router.get   ('/students/exam-activity',        getStudentExamActivity);
router.put   ('/students/:id',          updateStudent);
router.delete('/students/:id',          deleteStudent);
router.patch ('/students/:id/password', changeStudentPassword);
router.patch ('/students/bulk-password', bulkChangeStudentPassword);   // ← NEW

// ── Excel Template & Upload ───────────────────────────────────────────────────
// IMPORTANT: these two routes must come BEFORE /exams/:id
// so Express doesn't treat "template" or "upload" as an :id value
router.get ('/exams/template/download',    downloadExamTemplate);
router.post('/exams/upload', handleUpload, uploadAndCreateExam);
router.post('/exams/questions/parse', handleUpload, parseQuestionsExcel);

// ── Exams (CRUD) ──────────────────────────────────────────────────────────────
router.get   ('/exams',     getExams);
router.post  ('/exams',     createExam);
router.get   ('/exams/:id', getExamById);
router.post  ('/exams/:id/ai-generate', generateExamQuestions);
router.put   ('/exams/:id', updateExam);
router.delete('/exams/:id', deleteExam);

// ── Results ───────────────────────────────────────────────────────────────────
router.get('/results',                    getAdminResults);
router.get('/results/exam/:examId',       getExamResults);
router.get('/results/student/:studentId', getStudentResultsByAdmin);
router.get('/results/export/:examId',     exportExamResults);

// ── Attendees ─────────────────────────────────────────────────────────────────
router.get   ('/exams/:examId/attendees',        getExamAttendees);
router.get   ('/exams/:examId/attendees/export', exportExamAttendees);

// ── Reset attempt ─────────────────────────────────────────────────────────────
router.delete('/exams/:examId/attempts/:studentId/reschedule', resetExamAttempt);

// ── Exam Attempts (admin view) ────────────────────────────────────────────────
router.get   ('/exams/:id/attempts',                           getExamAttempts);
router.delete('/exams/:examId/attempts/:studentId/reschedule', rescheduleAttempt);

export default router;