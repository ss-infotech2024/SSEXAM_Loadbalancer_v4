import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "../components/layout/AdminLayout";
import Home from "../pages/Home";
import SuperAdminDashboard from "../pages/superadmin/SuperAdminDashboard";
import AdminDashboard from "../pages/admin/AdminDashboard";
import AddStudent from "../pages/admin/AddStudent";
import ViewStudents from "../pages/admin/ViewStudents";
import StudentScores from "../pages/admin/StudentScores";
import CreateExam from "../pages/admin/CreateExam";
import ExamList from "../pages/admin/Examlist";
import EditExam from "../pages/admin/Editexam";
import QuestionLibrary from "../pages/admin/QuestionLibrary";

// ── Student pages (each has its own layout/sidebar built-in) ──────────────────
import StudentDashboard from "../pages/student/StudentDashboard";
import StudentExams from "../pages/student/Studentexams";
import StudentResults from "../pages/student/StudentResults";
import ExamAttempts from "../pages/admin/ExamAttempts";
import QRScanner from "../pages/admin/QRScanner";
import StudentRegistrationQR from "../pages/admin/StudentRegistrationQR";
import StudentRegistration from "../pages/student/StudentRegistration";

// ─── PROTECTED ROUTE ──────────────────────────────────────────────────────────
const ProtectedRoute = ({ children, allowedRoles }) => {
  const token    = localStorage.getItem("token");
  const userRole = localStorage.getItem("userRole");

  if (!token) return <Navigate to="/" replace />;
  if (allowedRoles && !allowedRoles.includes(userRole)) return <Navigate to="/" replace />;
  return children;
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const AppRouter = () => {
  return (
    <Routes>

      {/* ── Public ── */}
      <Route path="/" element={<Home />} />

      {/* ── Super Admin ── (tab is derived from the URL inside SuperAdminDashboard) */}
      <Route path="/superadmin/*" element={
        <ProtectedRoute allowedRoles={["superadmin"]}>
          <SuperAdminDashboard />
        </ProtectedRoute>
      }/>

      <Route
        path="/admin/qr-scanner"
        element={
          <ProtectedRoute allowedRoles={["admin"]}>
            <AdminLayout>
              <QRScanner />
            </AdminLayout>
          </ProtectedRoute>
        }
      />

      {/* ── Admin ── */}
      <Route path="/admin/*" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><AdminDashboard /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/dashboard" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><AdminDashboard /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route
        path="/admin/student-registration-qr"
        element={
          <ProtectedRoute allowedRoles={["admin"]}>
            <AdminLayout>
              <StudentRegistrationQR />
            </AdminLayout>
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/student-registration/:token"
        element={<StudentRegistration />}
      />

      <Route path="/admin/add-student" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><AddStudent /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/exams/:id/attempts" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><ExamAttempts /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/view-students" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><ViewStudents /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/student-scores" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><StudentScores /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/create-exam" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><CreateExam /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/question-library" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><QuestionLibrary /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/exams" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><ExamList /></AdminLayout>
        </ProtectedRoute>
      }/>

      {/* keep old /get-exams path working too */}
      <Route path="/admin/get-exams" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><ExamList /></AdminLayout>
        </ProtectedRoute>
      }/>

      <Route path="/admin/exams/:id/edit" element={
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminLayout><EditExam /></AdminLayout>
        </ProtectedRoute>
      }/>

      {/* ── Student ─────────────────────────────────────────────────────────
           NOTE: StudentDashboard / StudentExams / StudentResults all contain
           their own <StudentLayout> (sidebar + topbar) internally.
           Do NOT wrap them in any extra layout here.
      ────────────────────────────────────────────────────────────────────── */}

      {/* catch-all /student/* → dashboard */}
      <Route path="/student" element={
        <ProtectedRoute allowedRoles={["student"]}>
          <Navigate to="/student/dashboard" replace />
        </ProtectedRoute>
      }/>

      <Route path="/student/*" element={
        <ProtectedRoute allowedRoles={["student"]}>
          <Navigate to="/student/dashboard" replace />
        </ProtectedRoute>
      }/>

      <Route path="/student/dashboard" element={
        <ProtectedRoute allowedRoles={["student"]}>
          <StudentDashboard />
        </ProtectedRoute>
      }/>

      <Route path="/student/exams" element={
        <ProtectedRoute allowedRoles={["student"]}>
          <StudentExams />
        </ProtectedRoute>
      }/>

      <Route path="/student/results" element={
        <ProtectedRoute allowedRoles={["student"]}>
          <StudentResults />
        </ProtectedRoute>
      }/>

      {/* ── Catch-all ── */}
      <Route path="*" element={<Navigate to="/" replace />} />

    </Routes>
  );
};

export default AppRouter;