// pages/admin/EditExam.jsx
import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { fetchExamById, updateExam, clearSelected, clearActionError, downloadExamTemplate } from "../../store/slices/examSlices";
import API from "@/services/api";
import CameraProctoringToggle from "../../components/exam/CameraProctoringToggle";
import ShuffleQuestionsToggle from "../../components/exam/ShuffleQuestionsToggle";
import ExamDetailsFields from "../../components/exam/ExamDetailsFields";
import QuestionEditorCard from "../../components/exam/QuestionEditorCard";
import SectionPicker from "../../components/exam/SectionPicker";
import SectionManager from "../../components/exam/SectionManager";
import ExamLibraryTools from "../../components/library/ExamLibraryTools";
import { sectionsFromQuestions, resolveSection, applySectionChange, sortBySection, countBySection, sectionErrors } from "../../utils/sections";
import {
  ArrowLeft, Save, Plus, ListPlus, Lock, CalendarClock, ShieldCheck, Building2, Info, FileSpreadsheet, Download, Sparkles,
} from "lucide-react";
import {
  PageHeader, Button, Card, CardHeader, Badge, Alert, EmptyState, ErrorState, LoadingState, Modal, useToast,
} from "../../components/ui";
import { isoToLocalInput, localToIST_ISO } from "../../utils/time";

const makeQuestion = (section = null) => ({
  _id: null,
  id:            Date.now() + Math.random(),
  section,
  text:          "",
  options:       ["", "", "", ""],
  correctAnswer: null,
});

// ── Excel import modal: choose replace / append, or show the file's errors ──
const ImportExcelModal = ({ result, currentCount, onReplace, onAppend, onClose }) => {
  if (result.error) {
    return (
      <Modal
        onClose={onClose}
        icon={FileSpreadsheet}
        title="Couldn't import this file"
        description="Fix these rows in Excel and upload again. Nothing was changed."
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
      >
        <Alert tone="danger">{result.error.message}</Alert>
        {result.error.errors?.length > 0 && (
          <ul className="mt-3 max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-slate-700">
            {result.error.errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </Modal>
    );
  }

  const n = result.questions.length;
  return (
    <Modal
      onClose={onClose}
      icon={FileSpreadsheet}
      title={`${n} question${n === 1 ? "" : "s"} found`}
      description={result.fileName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {currentCount > 0 && <Button variant="secondary" icon={Plus} onClick={onAppend}>Add to end ({currentCount + n})</Button>}
          <Button onClick={onReplace}>{currentCount > 0 ? `Replace all ${currentCount}` : "Load questions"}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {currentCount > 0 && (
          <Alert tone="warning">
            This exam has <strong>{currentCount}</strong> questions. <strong>Replace</strong> removes them and uses only the Excel questions;
            <strong> Add to end</strong> keeps them and adds the new ones after.
          </Alert>
        )}
        <p className="text-sm text-slate-600">
          Questions load into the editor below so you can check them. Nothing is saved until you click <strong>Save changes</strong>.
        </p>
      </div>
    </Modal>
  );
};

// Map the fetched exam into form state (UTC → IST for the datetime inputs)
const toFormState = (selected) => ({
  examData: {
    subject:   selected.subject,
    duration:  String(selected.duration),
    startTime: isoToLocalInput(selected.startTime),
    endTime:   isoToLocalInput(selected.endTime),
    cameraEnabled: selected.cameraEnabled !== false, // older exams have no field → ON
    shuffleQuestions: selected.shuffleQuestions === true, // older exams have no field → OFF
  },
  marksPerQuestion: selected.marksPerQuestion ?? 1,
  // Older exams have no saved section list → use the names their questions already carry
  sections: selected.sections?.length ? [...selected.sections] : sectionsFromQuestions(selected.questions),
  questions: (selected.questions || []).map((q) => ({
    _id:           q._id,
    id:            q._id || Date.now() + Math.random(),
    section:       q.section || null, // older exams have no sections
    text:          q.text,
    options:       [...q.options],
    correctAnswer: q.correctAnswer,
  })),
});

// ═════════════════════════════════════════════════════════════════════════════
const EditExam = () => {
  const navigate = useNavigate();
  const { id }   = useParams();
  const dispatch = useDispatch();
  const showToast = useToast();
  const { selected, loading, actionLoading, actionError, error } = useSelector((s) => s.exams);

  useEffect(() => {
    const role  = localStorage.getItem("userRole");
    const dept  = localStorage.getItem("adminDepartment");
    const token = localStorage.getItem("token");
    if (!token || role !== "admin" || !dept) navigate("/");
  }, []); // eslint-disable-line

  const adminDept = localStorage.getItem("adminDepartment") || "";

  const [examData,         setExamData]         = useState({ subject: "", duration: "", startTime: "", endTime: "", cameraEnabled: true });
  const [marksPerQuestion, setMarksPerQuestion] = useState(null); // read-only after fetch
  const [questions,        setQuestions]        = useState([]);
  const [sections,         setSections]         = useState([]);   // admin-defined, in display order
  const [errors,           setErrors]           = useState({});
  const [loadedId,         setLoadedId]         = useState(null);
  const [activeSection,    setActiveSection]    = useState(null); // where "Add question" puts new ones
  const activeName = sections.includes(activeSection) ? activeSection : (sections[0] ?? null);

  const [importing,        setImporting]        = useState(false);
  const [importResult,     setImportResult]     = useState(null); // { fileName, questions } | { error }

  const aiExam = selected?.aiConfig?.enabled === true;
  const [aiBusy, setAiBusy] = useState(false);

  // Admin generates (or regenerates) the AI paper early so it can be reviewed before students see it
  const handleGenerateAi = async () => {
    if (questions.length > 0 && !window.confirm("This replaces the current questions with a new AI-generated set. Continue?")) return;
    setAiBusy(true);
    try {
      await API.post(`/admin/exams/${id}/ai-generate`, {}, { timeout: 90000 });
      setLoadedId(null);               // re-fill the form from the fresh exam
      await dispatch(fetchExamById(id));
      showToast("AI questions generated. Review them below.", "success");
    } catch (err) {
      showToast(err.response?.data?.message || "Could not generate questions.", "error");
    } finally {
      setAiBusy(false);
    }
  };

  const questionRefs = useRef([]);
  const fileInputRef = useRef(null);

  useEffect(() => { if (actionError) showToast(actionError, "error"); }, [actionError, showToast]);

  useEffect(() => {
    dispatch(fetchExamById(id));
    return () => {
      dispatch(clearSelected());
      dispatch(clearActionError());
    };
  }, [id, dispatch]);

  // Pre-fill the form once per fetched exam (adjusting state during render instead of in an effect)
  if (selected && selected._id !== loadedId) {
    const s = toFormState(selected);
    setLoadedId(selected._id);
    setExamData(s.examData);
    setMarksPerQuestion(s.marksPerQuestion);
    setQuestions(s.questions);
    setSections(s.sections);
  }

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleInfoChange = (e) => {
    const { name, value } = e.target;
    setExamData((p) => ({ ...p, [name]: value }));
    if (errors[name]) setErrors((p) => ({ ...p, [name]: "" }));
  };

  const handleSectionsChange = (change) => {
    setSections(change.sections);
    if (change.rename) {
      setQuestions((p) => applySectionChange(p, change));
      if (change.rename.from === activeSection) setActiveSection(change.rename.to);
    }
    // old "choose a section" errors may no longer apply
    setErrors((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.endsWith("-section"))));
  };

  const addQuestion = () => {
    const q = makeQuestion(activeName);
    setQuestions((p) => [...p, q]);
    setTimeout(() => questionRefs.current[questions.length]?.focus(), 80);
  };

  // Questions coming from the library / AI: filled in, placed in the section being worked on
  const addImported = (list) =>
    setQuestions((p) => [...p, ...list.map((q) => ({ ...makeQuestion(activeName), text: q.text, options: q.options, correctAnswer: q.correctAnswer }))]);

  const addTenQuestions = () => {
    setQuestions((p) => [...p, ...Array.from({ length: 10 }, () => makeQuestion(activeName))]);
  };

  const removeQuestion = (lid) => setQuestions((p) => p.filter((q) => q.id !== lid));

  // ── Excel import — same template as Create Exam (only the "Questions" sheet is read) ──
  const handleExcelFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      showToast("Please choose an .xlsx file.", "error");
      return;
    }

    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("examFile", file);
      const res = await API.post("/admin/exams/questions/parse", fd);
      setImportResult({ fileName: file.name, questions: res.data.questions || [], sections: res.data.sections || [] });
    } catch (err) {
      const data = err.response?.data;
      setImportResult({
        error: {
          message: data?.message || err.message || "Failed to read the Excel file.",
          errors:  Array.isArray(data?.errors) ? data.errors : [],
        },
      });
    } finally {
      setImporting(false);
    }
  };

  const applyImport = (mode) => {
    // Section names come from the Excel file: reuse this exam's spelling when a name matches,
    // otherwise add it to the exam's sections.
    const merged = [...sections];
    (importResult.sections || []).forEach((name) => { if (!resolveSection(name, merged)) merged.push(name); });
    const imported = importResult.questions.map((q) => ({
      _id:           null,
      id:            Date.now() + Math.random(),
      section:       resolveSection(q.section, merged) || activeName, // blank in the file → the section being filled
      text:          q.text,
      options:       [...q.options],
      correctAnswer: q.correctAnswer,
    }));
    setSections(merged);
    setQuestions((p) => (mode === "replace" ? imported : [...p, ...imported]));
    setErrors((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("q-"))));
    setImportResult(null);
    showToast(
      `${imported.length} question${imported.length === 1 ? "" : "s"} ${mode === "replace" ? "loaded" : "added"} — click Save changes to keep them.`,
      "success"
    );
  };

  const handleDownloadTemplate = async () => {
    const res = await dispatch(downloadExamTemplate());
    if (res.meta.requestStatus === "rejected") showToast(res.payload || "Failed to download template", "error");
  };

  const updateQuestion = (lid, field, value, optIdx = null) => {
    setQuestions((p) =>
      p.map((q) => {
        if (q.id !== lid) return q;
        if (field === "text")          return { ...q, text: value };
        if (field === "section")       return { ...q, section: value };
        if (field === "option") {
          const opts = [...q.options];
          opts[optIdx] = value;
          return { ...q, options: opts };
        }
        if (field === "correctAnswer") return { ...q, correctAnswer: parseInt(value, 10) };
        return q;
      })
    );
    const key = field === "option" ? `q-${lid}-opt${optIdx}` : `q-${lid}-${field === "correctAnswer" ? "correct" : field}`;
    if (errors[key]) setErrors((p) => { const u = { ...p }; delete u[key]; return u; });
  };

  // ── Validation ─────────────────────────────────────────────────────────────
  const validate = () => {
    const e = {};
    if (!examData.subject.trim())                              e.subject   = "Subject is required";
    if (!examData.duration || Number(examData.duration) <= 0) e.duration  = "Enter a valid duration";
    if (!examData.startTime)                                   e.startTime = "Start time is required";
    if (!examData.endTime)                                     e.endTime   = "End time is required";
    if (
      examData.startTime &&
      examData.endTime &&
      new Date(examData.endTime) <= new Date(examData.startTime)
    )                                                          e.endTime   = "End time must be after start time";
    questions.forEach((q) => {
      if (!q.text.trim())           e[`q-${q.id}-text`]    = "Question text required";
      q.options.forEach((o, i) => {
        if (!o.trim())              e[`q-${q.id}-opt${i}`] = `Option ${i + 1} required`;
      });
      if (q.correctAnswer === null) e[`q-${q.id}-correct`] = "Select the correct answer";
    });
    Object.assign(e, sectionErrors(questions, sections));
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const awaitingAi = aiExam && questions.length === 0;   // AI paper not generated yet — fine, the server will do it
    if (questions.length === 0 && !awaitingAi) { showToast("Add at least one question.", "error"); return; }
    if (!validate())            { showToast("Fix the errors before saving.", "error"); return; }

    const payload = {
      subject:   examData.subject.trim(),
      duration:  Number(examData.duration),
      // Convert datetime-local (IST) → UTC ISO string before sending to backend
      startTime: localToIST_ISO(examData.startTime),
      endTime:   localToIST_ISO(examData.endTime),
      // marksPerQuestion intentionally NOT sent — backend ignores it on update
      cameraEnabled: examData.cameraEnabled !== false,
      shuffleQuestions: examData.shuffleQuestions === true,
      sections,
      ...(awaitingAi ? {} : {
        questions: sortBySection(questions, sections).map((q) => ({
          section:       q.section || undefined,
          text:          q.text.trim(),
          options:       q.options.map((o) => o.trim()),
          correctAnswer: q.correctAnswer,
        })),
      }),
    };

    const res = await dispatch(updateExam({ id, body: payload }));
    if (res.meta.requestStatus === "fulfilled") {
      showToast("Exam updated successfully!", "success");
      setTimeout(() => navigate("/admin/exams"), 1500);
    }
  };

  const totalMarks = questions.length * (marksPerQuestion ?? 1);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading && !selected) {
    return <Card><LoadingState label="Loading exam…" /></Card>;
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error && !selected) {
    return (
      <Card>
        <ErrorState title="Failed to load exam" message={error} onRetry={() => dispatch(fetchExamById(id))} />
        <div className="-mt-8 flex justify-center pb-10">
          <Button variant="ghost" icon={ArrowLeft} onClick={() => navigate("/admin/exams")}>Back to exams</Button>
        </div>
      </Card>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Edit exam"
        description={examData.subject || "Loading…"}
        eyebrow={
          <button type="button" onClick={() => navigate("/admin/exams")} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-4 w-4" /> Exams
          </button>
        }
        actions={<Button icon={Save} onClick={handleSave} loading={actionLoading}>{actionLoading ? "Saving…" : "Save changes"}</Button>}
      />

      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Exam details"
            icon={CalendarClock}
            actions={adminDept && <Badge tone="brand" icon={Building2}>{adminDept}</Badge>}
          />
          <div className="card-body space-y-5">
            <ExamDetailsFields examData={examData} errors={errors} onChange={handleInfoChange} />

            {marksPerQuestion && (
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                <Lock className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                <p className="text-sm text-slate-700">
                  <strong className="text-slate-900">{marksPerQuestion} mark{marksPerQuestion > 1 ? "s" : ""} per question</strong>
                  <span className="text-slate-500"> — set at creation and locked. </span>
                  {questions.length} questions = <strong className="text-slate-900">{totalMarks} marks</strong>
                </p>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Proctoring" icon={ShieldCheck} />
          <div className="card-body space-y-4">
            <CameraProctoringToggle
              enabled={examData.cameraEnabled !== false}
              onChange={(v) => setExamData((p) => ({ ...p, cameraEnabled: v }))}
            />
            <ShuffleQuestionsToggle
              enabled={examData.shuffleQuestions === true}
              onChange={(v) => setExamData((p) => ({ ...p, shuffleQuestions: v }))}
            />
          </div>
        </Card>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Questions <span className="font-normal text-slate-500">({questions.length})</span></h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" icon={Download} onClick={handleDownloadTemplate}>Template</Button>
              <Button variant="secondary" icon={FileSpreadsheet} loading={importing} onClick={() => fileInputRef.current?.click()}>
                {importing ? "Reading…" : "Import from Excel"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={handleExcelFile}
              />
              <ExamLibraryTools questions={questions} sectionName={activeName} subject={examData.subject} onAdd={addImported} />
              <Button variant="secondary" icon={Plus} onClick={addQuestion}>Add question</Button>
              <Button variant="secondary" icon={ListPlus} onClick={addTenQuestions}>Add 10</Button>
            </div>
          </div>

          {aiExam && (
            <Alert tone="info" icon={Sparkles}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  AI exam — {(selected.aiConfig.parts || []).map((p) => `${p.topic}: ${p.count} (${p.difficulty})`).join(" · ")}.{" "}
                  {questions.length === 0
                    ? "Not generated yet; it is created automatically when the first student opens the exam."
                    : "Review the questions below; AI can make mistakes."}
                  {selected.aiConfig.status === "failed" && selected.aiConfig.error ? ` Last attempt failed: ${selected.aiConfig.error}` : ""}
                </span>
                <Button size="sm" variant="secondary" icon={Sparkles} loading={aiBusy} onClick={handleGenerateAi}>
                  {questions.length === 0 ? "Generate now" : "Regenerate"}
                </Button>
              </div>
            </Alert>
          )}

          <SectionManager sections={sections} counts={countBySection(questions, sections)} onChange={handleSectionsChange} />

          {sections.length > 0 && (
            <Card className="p-4">
              <SectionPicker sections={sections} active={activeName} counts={countBySection(questions, sections)} onChange={setActiveSection} />
            </Card>
          )}

          <Alert tone="info" icon={Info}>Saving replaces the full question set with what you see below.</Alert>

          {questions.length === 0 ? (
            <Card>
              <EmptyState
                icon={ListPlus}
                title="No questions yet"
                action={<Button icon={Plus} onClick={addQuestion}>Add first question</Button>}
              />
            </Card>
          ) : (
            questions.map((q, index) => (
              <QuestionEditorCard
                key={q.id}
                index={index}
                question={q}
                sections={sections}
                marks={marksPerQuestion}
                errors={errors}
                inputRef={(el) => (questionRefs.current[index] = el)}
                onChange={(field, value, optIdx) => updateQuestion(q.id, field, value, optIdx)}
                onRemove={() => removeQuestion(q.id)}
              />
            ))
          )}

          {/* Sticky action bar */}
          <div className="sticky bottom-0 z-20 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="secondary" onClick={() => navigate("/admin/exams")}>Cancel</Button>
              <Button icon={Save} size="lg" onClick={handleSave} loading={actionLoading}>
                {actionLoading ? "Saving…" : `Save changes · ${questions.length} Q · ${totalMarks} marks`}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {importResult && (
        <ImportExcelModal
          result={importResult}
          currentCount={questions.length}
          onReplace={() => applyImport("replace")}
          onAppend={() => applyImport("append")}
          onClose={() => setImportResult(null)}
        />
      )}
    </>
  );
};

export default EditExam;
