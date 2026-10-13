// pages/admin/CreateExam.jsx
import React, { useState, useRef, useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import {
  createExam,
  createExamFromExcel,
  downloadExamTemplate,
  clearActionError,
} from "../../store/slices/examSlices";
import {
  PencilLine, UploadCloud, Sparkles, Download, FileSpreadsheet, Plus, ListPlus, ArrowLeft, ArrowRight, Check,
  Building2, Star, CalendarClock, Trash2, X, ListChecks,
} from "lucide-react";
import CameraProctoringToggle from "../../components/exam/CameraProctoringToggle";
import ShuffleQuestionsToggle from "../../components/exam/ShuffleQuestionsToggle";
import ExamDetailsFields from "../../components/exam/ExamDetailsFields";
import QuestionEditorCard from "../../components/exam/QuestionEditorCard";
import SectionPicker from "../../components/exam/SectionPicker";
import SectionManager from "../../components/exam/SectionManager";
import ExamLibraryTools from "../../components/library/ExamLibraryTools";
import { DEFAULT_SECTIONS, sectionsFromQuestions, applySectionChange, sortBySection, countBySection, sectionErrors } from "../../utils/sections";
import {
  PageHeader, Button, Card, CardHeader, Tabs, Badge, Alert, EmptyState, ConfirmDialog, useToast,
} from "../../components/ui";
import { formatIST, localToIST_ISO } from "../../utils/time";
import { cn } from "../../utils/cn";
import { loadDraft, saveDraft, clearDraft } from "../../utils/examDraft";

// ─── Constants ────────────────────────────────────────────────────────────────
const EMPTY_EXAM    = { subject: "", duration: "", startTime: "", endTime: "", marksPerQuestion: "", cameraEnabled: true, shuffleQuestions: false };
const MARKS_OPTIONS = [1, 2, 3, 4, 5];
const EMPTY_PART    = { topic: "", count: 5, difficulty: "medium" };
const EMPTY_AI      = { language: "English", parts: [{ ...EMPTY_PART }] };
const AI_MAX_PARTS  = 8;
const AI_MAX_TOTAL  = 60;
const makeQuestion  = (section = null) => ({ id: Date.now() + Math.random(), section, text: "", options: ["", "", "", ""], correctAnswer: null });

// ─── Helper: extract user-friendly message from rejected thunk payload ─────────
const getErrorMessage = (payload) => {
  if (!payload) return "Something went wrong. Please try again.";
  if (typeof payload === "string") return payload;
  if (payload.message) {
    if (payload.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
      return `${payload.message}\n${payload.errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
    }
    return payload.message;
  }
  return "Something went wrong. Please try again.";
};

// ─── Excel Upload Panel ───────────────────────────────────────────────────────
const ExcelPanel = ({ onSuccess, showToast }) => {
  const dispatch   = useDispatch();
  const { excelUploading, templateDownloading } = useSelector((s) => s.exams);

  const [dragOver,      setDragOver]      = useState(false);
  const [selectedFile,  setSelectedFile]  = useState(null);
  const [uploadErrors,  setUploadErrors]  = useState([]);
  const fileInputRef = useRef(null);

  const handleFile = (file) => {
    setUploadErrors([]);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setUploadErrors(["Only .xlsx files are accepted. Please use the provided template."]);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadErrors(["File is too large. Maximum size is 5 MB."]);
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const clearFile = () => {
    setSelectedFile(null);
    setUploadErrors([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    const res = await dispatch(createExamFromExcel(selectedFile));

    if (res.meta.requestStatus === "fulfilled") {
      showToast(
        `Exam "${res.payload?.exam?.subject || res.payload?.subject || 'New Exam'}" created with ${res.payload?.exam?.questionCount || res.payload?.questionCount || 0} questions!`,
        "success"
      );
      clearFile();
      onSuccess?.();
    } else {
      const msg = getErrorMessage(res.payload);
      // Split by newlines for display as bullet list
      const lines = msg.split("\n").filter(Boolean);
      setUploadErrors(lines.length > 0 ? lines : [msg]);
      showToast(lines[0] || msg, "error");
    }
  };

  const handleDownloadTemplate = async () => {
    const res = await dispatch(downloadExamTemplate());
    if (res.meta.requestStatus === "rejected") {
      showToast(getErrorMessage(res.payload), "error");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* How-to */}
      <Card className="lg:col-span-2">
        <CardHeader title="How it works" icon={ListChecks} />
        <div className="card-body space-y-5">
          <ol className="space-y-4">
            {[
              ["Download the template", "The .xlsx template has the exact columns the server expects."],
              ["Fill in both sheets", "Add exam info on the Exam Info sheet and one row per question on Questions. Type any section names you like in the Section column — leave it empty for no sections."],
              ["Upload the file", "The exam is created immediately. Any row errors are listed so you can fix them."],
            ].map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">{i + 1}</span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{title}</p>
                  <p className="text-sm text-slate-500">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <Button variant="secondary" icon={Download} onClick={handleDownloadTemplate} loading={templateDownloading} fullWidth>
            {templateDownloading ? "Downloading…" : "Download template (.xlsx)"}
          </Button>
        </div>
      </Card>

      {/* Upload */}
      <Card className="lg:col-span-3">
        <CardHeader title="Upload completed file" icon={UploadCloud} />
        <div className="card-body space-y-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose an Excel file to upload"
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragOver ? "border-brand-500 bg-brand-50"
                : selectedFile ? "border-emerald-300 bg-emerald-50/50"
                : "border-slate-300 bg-slate-50 hover:border-brand-400 hover:bg-brand-50/50"
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => handleFile(e.target.files[0])}
            />
            {selectedFile ? (
              <>
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <FileSpreadsheet className="h-6 w-6" />
                </span>
                <p className="text-sm font-semibold text-slate-900">{selectedFile.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">{(selectedFile.size / 1024).toFixed(1)} KB · ready to upload</p>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); clearFile(); }}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:underline"
                >
                  <X className="h-3.5 w-3.5" /> Remove file
                </button>
              </>
            ) : (
              <>
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white text-slate-400 shadow-card">
                  <UploadCloud className="h-6 w-6" />
                </span>
                <p className="text-sm font-semibold text-slate-800">
                  Drop your .xlsx file here, or <span className="text-brand-700 underline">browse</span>
                </p>
                <p className="mt-1 text-xs text-slate-500">Only .xlsx · max 5 MB</p>
              </>
            )}
          </div>

          {uploadErrors.length > 0 && (
            <Alert tone="danger" title="Fix these issues and upload again">
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {uploadErrors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </Alert>
          )}

          <Button icon={UploadCloud} onClick={handleUpload} disabled={!selectedFile} loading={excelUploading} fullWidth size="lg">
            {excelUploading ? "Creating exam…" : "Upload & create exam"}
          </Button>
        </div>
      </Card>
    </div>
  );
};

// ─── Step indicator ───────────────────────────────────────────────────────────
const Steps = ({ step, questionCount, onStep }) => (
  <ol className="mb-6 flex items-center gap-3" aria-label="Progress">
    {[
      { n: 1, label: "Exam details" },
      { n: 2, label: `Questions (${questionCount})` },
    ].map(({ n, label }, i) => {
      const done = step > n;
      const current = step === n;
      return (
        <li key={n} className="flex items-center gap-3">
          {i > 0 && <span className={cn("h-px w-6 sm:w-12", step >= n ? "bg-brand-400" : "bg-slate-300")} aria-hidden="true" />}
          <button
            type="button"
            onClick={() => onStep(n)}
            aria-current={current ? "step" : undefined}
            className="flex items-center gap-2 rounded-md text-sm font-semibold"
          >
            <span
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold",
                current ? "bg-brand-600 text-white" : done ? "bg-brand-100 text-brand-700" : "bg-slate-200 text-slate-600"
              )}
            >
              {done ? <Check className="h-4 w-4" /> : n}
            </span>
            <span className={current ? "text-slate-900" : "text-slate-500"}>{label}</span>
          </button>
        </li>
      );
    })}
  </ol>
);

// ═════════════════════════════════════════════════════════════════════════════
const CreateExam = () => {
  const navigate  = useNavigate();
  const location  = useLocation();
  const dispatch  = useDispatch();
  const showToast = useToast();
  const { actionLoading, actionError } = useSelector((s) => s.exams);

  // "manual" | "excel" | "ai"
  const [mode, setMode] = useState("manual");
  // "ai": the admin only describes the paper; the server generates the questions once, when needed
  const [ai, setAi] = useState(EMPTY_AI);

  const [draft] = useState(loadDraft);

  useEffect(() => {
    const role  = localStorage.getItem("userRole");
    const dept  = localStorage.getItem("adminDepartment");
    const token = localStorage.getItem("token");
    if (!token || role !== "admin" || !dept) navigate("/");
    dispatch(clearActionError());
  }, []); // eslint-disable-line

  const adminDept = localStorage.getItem("adminDepartment") || "";

  const [step,      setStep]      = useState(draft?.step ?? 1);
  const [examData,  setExamData]  = useState(draft?.examData ?? EMPTY_EXAM);
  const [questions, setQuestions] = useState(draft?.questions ?? []);
  // Admin-defined section names. New exams start from the defaults; drafts keep their own.
  const [sections,  setSections]  = useState(draft ? (draft.sections ?? sectionsFromQuestions(draft.questions)) : DEFAULT_SECTIONS);
  const [errors,    setErrors]    = useState({});
  const [activeSection, setActiveSection] = useState(null); // where "Add question" puts new ones
  const activeName = sections.includes(activeSection) ? activeSection : (sections[0] ?? null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    // Opened via "Duplicate" on the exam list — the copy was saved as the draft
    const duplicatedFrom = location.state?.duplicatedFrom;
    if (duplicatedFrom) {
      showToast(`Copied "${duplicatedFrom}". Set a new schedule, review the questions, then create.`, "info");
      navigate(location.pathname, { replace: true, state: null }); // don't repeat on refresh
    } else if (draft && (draft.questions?.length > 0 || draft.examData?.subject)) {
      showToast("Restored your unsaved exam draft.", "info");
    }
  }, []); // eslint-disable-line

  const questionRefs = useRef([]);

  useEffect(() => {
    if (actionError) {
      const msg = getErrorMessage(actionError);
      showToast(msg, "error");
    }
  }, [actionError, showToast]);

  useEffect(() => {
    saveDraft({ step, examData, questions, sections });
  }, [step, examData, questions, sections]);

  // ── Step 1 handlers ────────────────────────────────────────────────────────
  const handleInfoChange = (e) => {
    const { name, value } = e.target;
    setExamData((p) => ({ ...p, [name]: value }));
    if (errors[name]) setErrors((p) => ({ ...p, [name]: "" }));
  };

  const selectMarks = (val) => {
    setExamData((p) => ({ ...p, marksPerQuestion: val }));
    if (errors.marksPerQuestion) setErrors((p) => ({ ...p, marksPerQuestion: "" }));
  };

  const validateStep1 = () => {
    const e = {};
    if (!examData.subject.trim())                               e.subject         = "Subject name is required";
    if (!examData.duration || Number(examData.duration) <= 0)  e.duration         = "Enter a valid duration in minutes";
    if (!examData.startTime)                                    e.startTime        = "Start time is required";
    if (!examData.endTime)                                      e.endTime          = "End time is required";
    if (
      examData.startTime &&
      examData.endTime &&
      new Date(examData.endTime) <= new Date(examData.startTime)
    )                                                           e.endTime          = "End time must be after start time";
    if (!examData.marksPerQuestion)                             e.marksPerQuestion = "Please select marks per question";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const setPart = (i, patch) => {
    setAi((p) => ({ ...p, parts: p.parts.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
    setErrors((p) => ({ ...p, aiParts: "" }));
  };
  const aiTotal = ai.parts.reduce((n, p) => n + (parseInt(p.count, 10) || 0), 0);

  const handleCreateAi = async () => {
    if (!validateStep1()) { showToast("Fix the errors in the exam details.", "error"); return; }
    let msg = "";
    const names = new Set();
    ai.parts.forEach((p, i) => {
      const n = parseInt(p.count, 10), name = p.topic.trim().replace(/\s+/g, " ").toLowerCase();
      if (!msg && !name)                 msg = `Topic ${i + 1}: enter a topic`;
      else if (!msg && names.has(name))  msg = `Topic "${p.topic.trim()}" is listed twice`;
      else if (!msg && !(n >= 1 && n <= 20)) msg = `Topic ${i + 1}: choose 1–20 questions`;
      names.add(name);
    });
    if (!msg && aiTotal > AI_MAX_TOTAL) msg = `At most ${AI_MAX_TOTAL} AI questions per exam (you have ${aiTotal})`;
    if (msg) { setErrors((p) => ({ ...p, aiParts: msg })); return; }

    const res = await dispatch(createExam({
      subject:          examData.subject.trim(),
      duration:         Number(examData.duration),
      startTime:        localToIST_ISO(examData.startTime),
      endTime:          localToIST_ISO(examData.endTime),
      marksPerQuestion: Number(examData.marksPerQuestion),
      cameraEnabled:    examData.cameraEnabled !== false,
      shuffleQuestions: examData.shuffleQuestions === true,
      aiConfig: {
        enabled: true,
        language: ai.language.trim() || "English",
        parts: ai.parts.map((p) => ({ topic: p.topic.trim(), count: parseInt(p.count, 10), difficulty: p.difficulty })),
      },
    }));
    if (res.meta.requestStatus === "fulfilled") {
      showToast(`Exam "${examData.subject}" created. ${aiTotal} AI questions will be generated for the students.`, "success");
      setExamData(EMPTY_EXAM);
      setAi(EMPTY_AI);
      setErrors({});
      navigate("/admin/exams");
    }
  };

  const goToStep = (n) => {
    if (n === 1) setStep(1);
    else if (validateStep1()) setStep(2);
  };

  // ── Step 2 handlers ────────────────────────────────────────────────────────
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
    setTimeout(() => questionRefs.current[questions.length]?.focus(), 80);
  };

  const removeQuestion = (id) => setQuestions((p) => p.filter((q) => q.id !== id));

  const updateQuestion = (id, field, value, optIdx = null) => {
    setQuestions((p) =>
      p.map((q) => {
        if (q.id !== id) return q;
        if (field === "text")          return { ...q, text: value };
        if (field === "section")       return { ...q, section: value };
        if (field === "option")        { const opts = [...q.options]; opts[optIdx] = value; return { ...q, options: opts }; }
        if (field === "correctAnswer") return { ...q, correctAnswer: parseInt(value, 10) };
        return q;
      })
    );
    const key = field === "option" ? `q-${id}-opt${optIdx}` : `q-${id}-${field === "correctAnswer" ? "correct" : field}`;
    if (errors[key]) setErrors((p) => { const u = { ...p }; delete u[key]; return u; });
  };

  const validateQuestions = () => {
    const e = {};
    questions.forEach((q) => {
      if (!q.text.trim())           e[`q-${q.id}-text`]    = "Question text is required";
      q.options.forEach((opt, i) => {
        if (!opt.trim())            e[`q-${q.id}-opt${i}`] = `Option ${i + 1} cannot be empty`;
      });
      if (q.correctAnswer === null) e[`q-${q.id}-correct`] = "Select the correct answer";
    });
    Object.assign(e, sectionErrors(questions, sections));
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Submit (manual) ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (questions.length === 0) { showToast("Please add at least one question.", "error"); return; }
    if (!validateQuestions())   { showToast("Fix the errors shown in the questions.", "error"); return; }

    const payload = {
      subject:          examData.subject.trim(),
      duration:         Number(examData.duration),
      startTime:        localToIST_ISO(examData.startTime),
      endTime:          localToIST_ISO(examData.endTime),
      marksPerQuestion: Number(examData.marksPerQuestion),
      cameraEnabled:    examData.cameraEnabled !== false,
      shuffleQuestions: examData.shuffleQuestions === true,
      sections,
      questions: sortBySection(questions, sections).map((q) => ({
        section:       q.section || undefined,
        text:          q.text.trim(),
        options:       q.options.map((o) => o.trim()),
        correctAnswer: q.correctAnswer,
      })),
    };

    const res = await dispatch(createExam(payload));
    if (res.meta.requestStatus === "fulfilled") {
      showToast(
        `Exam "${examData.subject}" created! Total marks: ${questions.length * Number(examData.marksPerQuestion)}`,
        "success"
      );
      setExamData(EMPTY_EXAM);
      setQuestions([]);
      setSections(DEFAULT_SECTIONS);
      setStep(1);
      setErrors({});
      clearDraft();
    }
  };

  const handleDiscardDraft = () => {
    setExamData(EMPTY_EXAM);
    setQuestions([]);
    setSections(DEFAULT_SECTIONS);
    setStep(1);
    setErrors({});
    clearDraft();
    setConfirmDiscard(false);
    showToast("Draft discarded.", "success");
  };

  // Called by ExcelPanel after a successful upload so the admin can see the list
  const handleExcelSuccess = useCallback(() => {
    setTimeout(() => navigate("/admin/exams"), 2000);
  }, [navigate]);

  const totalMarks      = questions.length * (Number(examData.marksPerQuestion) || 0);
  const hasDraftContent = examData.subject || questions.length > 0;
  const sectionCounts   = countBySection(questions, sections);
  const answeredCount   = questions.filter((q) => q.correctAnswer !== null).length;
  const customMarks     = examData.marksPerQuestion && !MARKS_OPTIONS.includes(examData.marksPerQuestion);

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Create exam"
        description="Build the paper by hand, or upload a completed Excel template."
        eyebrow={adminDept && <Badge tone="brand" icon={Building2}>{adminDept} department</Badge>}
        actions={
          mode === "manual" && hasDraftContent && (
            <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDiscard(true)}>Discard draft</Button>
          )
        }
      />

      <Tabs
        label="Creation method"
        value={mode}
        onChange={setMode}
        className="mb-6"
        items={[
          { value: "manual", label: "Manual entry", icon: PencilLine },
          // { value: "excel",  label: "Upload Excel", icon: UploadCloud },
          // { value: "ai",     label: "AI generated", icon: Sparkles },
        ]}
      />

      {/* ══ EXCEL MODE ══════════════════════════════════════════════════════ */}
      {mode === "excel" && <ExcelPanel onSuccess={handleExcelSuccess} showToast={showToast} />}

      {mode === "manual" && <Steps step={step} questionCount={questions.length} onStep={goToStep} />}

      {/* ══ MANUAL MODE — STEP 1 ════════════════════════════════════════════ */}
      {(mode === "manual" || mode === "ai") && step === 1 && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Exam details" description="Name, length and the window in which students can start." icon={CalendarClock} />
            <div className="card-body">
              <ExamDetailsFields examData={examData} errors={errors} onChange={handleInfoChange} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Scoring" description="Marks per question can't be changed after the exam is created." icon={Star} />
            <div className="card-body">
              <fieldset>
                <legend className="label">
                  Marks per question <span className="text-rose-600" aria-hidden="true">*</span>
                </legend>
                <div className="flex flex-wrap items-center gap-2">
                  {MARKS_OPTIONS.map((val) => {
                    const active = examData.marksPerQuestion === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => selectMarks(val)}
                        aria-pressed={active}
                        className={cn(
                          "h-11 w-11 rounded-lg border text-sm font-bold tabular transition-colors",
                          active ? "border-brand-600 bg-brand-600 text-white shadow-sm"
                                 : "border-slate-300 bg-white text-slate-700 hover:border-brand-400 hover:text-brand-700"
                        )}
                      >
                        {val}
                      </button>
                    );
                  })}
                  <span className="mx-1 text-xs text-slate-500">or</span>
                  <label className="sr-only" htmlFor="custom-marks">Custom marks per question (1–10)</label>
                  <input
                    id="custom-marks"
                    type="number" min="1" max="10" placeholder="Custom"
                    value={customMarks ? examData.marksPerQuestion : ""}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (v >= 1 && v <= 10) selectMarks(v);
                      else if (e.target.value === "") setExamData((p) => ({ ...p, marksPerQuestion: "" }));
                    }}
                    className={cn("input h-11 w-24 text-center font-semibold", customMarks && "border-brand-600 ring-4 ring-brand-500/15")}
                  />
                </div>
                {errors.marksPerQuestion
                  ? <p className="field-error">{errors.marksPerQuestion}</p>
                  : <p className="hint">{examData.marksPerQuestion
                      ? `Each question is worth ${examData.marksPerQuestion} mark${examData.marksPerQuestion > 1 ? "s" : ""}.`
                      : "Choose 1–5, or enter a custom value up to 10."}</p>}
              </fieldset>
            </div>
          </Card>

          <Card>
            <CardHeader title="Proctoring" icon={ListChecks} />
            <div className="card-body space-y-4">
              {/* Camera proctoring (drafts saved before this field existed → ON) */}
              <CameraProctoringToggle
                enabled={examData.cameraEnabled !== false}
                onChange={(v) => setExamData((p) => ({ ...p, cameraEnabled: v }))}
              />
              <ShuffleQuestionsToggle
                enabled={examData.shuffleQuestions === true}
                onChange={(v) => setExamData((p) => ({ ...p, shuffleQuestions: v }))}
              />
              <Alert tone="info" icon={Building2}>
                Only <strong>{adminDept}</strong> department students will see this exam.
              </Alert>
            </div>
          </Card>

          {mode === "ai" ? (
            <>
              <Card>
                <CardHeader title="AI questions" description="Add one row per topic. Each topic becomes its own section with the number of questions you set. Generated once; every student gets the same paper." icon={Sparkles} />
                <div className="card-body space-y-3">
                  {ai.parts.map((p, i) => (
                    <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_7rem_8rem_auto] sm:items-end">
                      <div>
                        <label className="label" htmlFor={`ai-topic-${i}`}>Topic / section {i + 1}</label>
                        <input id={`ai-topic-${i}`} className="input" maxLength={50} placeholder="e.g. Java collections"
                          value={p.topic} onChange={(e) => setPart(i, { topic: e.target.value })} />
                      </div>
                      <div>
                        <label className="label" htmlFor={`ai-count-${i}`}>Questions</label>
                        <input id={`ai-count-${i}`} type="number" min="1" max="20" className="input"
                          value={p.count} onChange={(e) => setPart(i, { count: e.target.value })} />
                      </div>
                      <div>
                        <label className="label" htmlFor={`ai-diff-${i}`}>Difficulty</label>
                        <select id={`ai-diff-${i}`} className="input" value={p.difficulty} onChange={(e) => setPart(i, { difficulty: e.target.value })}>
                          <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
                        </select>
                      </div>
                      <Button variant="ghost" icon={Trash2} disabled={ai.parts.length === 1} aria-label={`Remove topic ${i + 1}`}
                        onClick={() => setAi((x) => ({ ...x, parts: x.parts.filter((_, j) => j !== i) }))} />
                    </div>
                  ))}
                  {errors.aiParts && <p className="field-error">{errors.aiParts}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Button variant="secondary" icon={Plus} disabled={ai.parts.length >= AI_MAX_PARTS}
                      onClick={() => setAi((x) => ({ ...x, parts: [...x.parts, { ...EMPTY_PART }] }))}>Add topic</Button>
                    <p className="text-sm text-slate-600">
                      Total: <strong className="text-slate-900">{aiTotal}</strong> questions
                      {examData.marksPerQuestion ? <> = <strong className="text-slate-900">{aiTotal * Number(examData.marksPerQuestion)}</strong> marks</> : null}
                    </p>
                  </div>
                  <div className="max-w-xs">
                    <label className="label" htmlFor="ai-lang">Language</label>
                    <input id="ai-lang" className="input" maxLength={30} value={ai.language} onChange={(e) => setAi((p) => ({ ...p, language: e.target.value }))} />
                  </div>
                </div>
              </Card>
              <Alert tone="info" icon={Sparkles}>
                Questions are generated when the first student opens the exam, or earlier if you press <strong>Generate now</strong> in Edit exam to review them.
                AI can make mistakes — reviewing the paper before the exam is recommended.
              </Alert>
              <div className="flex justify-end">
                <Button size="lg" icon={Check} onClick={handleCreateAi} loading={actionLoading}>
                  {actionLoading ? "Creating…" : "Create AI exam"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex justify-end">
              <Button size="lg" iconRight={ArrowRight} onClick={() => goToStep(2)}>Continue to questions</Button>
            </div>
          )}
        </div>
      )}

      {/* ══ MANUAL MODE — STEP 2 ════════════════════════════════════════════ */}
      {mode === "manual" && step === 2 && (
        <div className="space-y-4">
          {/* Summary */}
          <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-slate-900">{examData.subject}</p>
              {examData.startTime && examData.endTime && (
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatIST(localToIST_ISO(examData.startTime))} → {formatIST(localToIST_ISO(examData.endTime))} · {examData.duration} min
                </p>
              )}
            </div>
            <dl className="flex gap-6 text-sm">
              <div><dt className="text-xs text-slate-500">Questions</dt><dd className="font-bold tabular text-slate-900">{questions.length}</dd></div>
              <div><dt className="text-xs text-slate-500">Answers set</dt><dd className="font-bold tabular text-slate-900">{answeredCount}/{questions.length}</dd></div>
              <div><dt className="text-xs text-slate-500">Total marks</dt><dd className="font-bold tabular text-slate-900">{totalMarks}</dd></div>
            </dl>
          </Card>

          <SectionManager sections={sections} counts={sectionCounts} onChange={handleSectionsChange} />

          {sections.length > 0 && (
            <Card className="p-4">
              <SectionPicker sections={sections} active={activeName} counts={sectionCounts} onChange={setActiveSection} />
            </Card>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <h2 className="text-base font-semibold text-slate-900">Questions</h2>
            <div className="flex flex-wrap gap-2">
              <ExamLibraryTools questions={questions} sectionName={activeName} subject={examData.subject} onAdd={addImported} />
              <Button variant="secondary" icon={Plus} onClick={addQuestion}>Add question</Button>
              <Button variant="secondary" icon={ListPlus} onClick={addTenQuestions}>Add 10</Button>
            </div>
          </div>

          {questions.length === 0 ? (
            <Card>
              <EmptyState
                icon={ListPlus}
                title="No questions yet"
                description="Each question is multiple choice with four options and one correct answer."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button icon={Plus} onClick={addQuestion}>Add first question</Button>
                    <Button variant="secondary" icon={ListPlus} onClick={addTenQuestions}>Add 10 blank</Button>
                  </div>
                }
              />
            </Card>
          ) : (
            questions.map((q, index) => (
              <QuestionEditorCard
                key={q.id}
                index={index}
                question={q}
                sections={sections}
                marks={examData.marksPerQuestion}
                errors={errors}
                inputRef={(el) => (questionRefs.current[index] = el)}
                onChange={(field, value, optIdx) => updateQuestion(q.id, field, value, optIdx)}
                onRemove={() => removeQuestion(q.id)}
              />
            ))
          )}

          {questions.length > 0 && (
            <div className="flex justify-center">
              <Button variant="ghost" icon={Plus} onClick={addQuestion}>Add another question</Button>
            </div>
          )}

          {/* Sticky action bar */}
          <div className="sticky bottom-0 z-20 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="secondary" icon={ArrowLeft} onClick={() => setStep(1)}>Back to details</Button>
              <Button onClick={handleSubmit} loading={actionLoading} disabled={questions.length === 0} icon={Check} size="lg">
                {actionLoading ? "Creating…" : `Create exam · ${questions.length} Q · ${totalMarks} marks`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          message="All exam details and questions you've entered will be removed. This cannot be undone."
          confirmLabel="Discard draft"
          onConfirm={handleDiscardDraft}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
};

export default CreateExam;
