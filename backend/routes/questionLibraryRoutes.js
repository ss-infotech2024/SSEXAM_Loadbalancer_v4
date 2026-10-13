// routes/questionLibraryRoutes.js
// Mount: app.use('/api/admin/question-library', questionLibraryRoutes)
import express from 'express';
import { protect, adminOnly } from '../middleware/auth.js';
import {
  getAiStatus, listQuestions, listTopics, createQuestion, bulkCreateQuestions,
  updateQuestion, deleteQuestion, bulkDeleteQuestions, generateQuestionDrafts,
} from '../controllers/questionLibraryController.js';

const router = express.Router();
router.use(protect, adminOnly);

// fixed paths first, then /:id
router.get ('/ai-status',   getAiStatus);
router.get ('/topics',      listTopics);
router.post('/generate',    generateQuestionDrafts);
router.post('/bulk',        bulkCreateQuestions);
router.post('/bulk-delete', bulkDeleteQuestions);

router.get   ('/',    listQuestions);
router.post  ('/',    createQuestion);
router.put   ('/:id', updateQuestion);
router.delete('/:id', deleteQuestion);

export default router;
