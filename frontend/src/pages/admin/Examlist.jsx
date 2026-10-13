// pages/admin/ExamList.jsx
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import API from "@/services/api";
import { fetchExams, deleteExam, updateExam, clearActionError } from "../../store/slices/examSlices";
import {
  Plus, Pencil, Trash2, Clock, ClipboardList, RefreshCw, CalendarClock, Radio, CheckCircle2,
  Users, Video, VideoOff, Inbox, Star, FilterX, Loader2, Copy,
} from "lucide-react";
import {
  PageHeader, Button, IconButton, StatCard, Card, SearchInput, Tabs, ExamStatusBadge, Badge,
  ConfirmDialog, EmptyState, ErrorState, Skeleton, useToast,
} from "../../components/ui";
import { formatIST, formatDateIST, formatDateTimeShortIST } from "../../utils/time";
import { cn } from "../../utils/cn";
import { saveDraft, draftHasContent } from "../../utils/examDraft";

// Click-to-toggle chip for per-exam camera proctoring (missing field = ON)
const CameraChip = ({ exam, toggling, onToggle }) => {
  const on = exam.cameraEnabled !== false;
  return (
    <button
      type="button"
      onClick={() => onToggle(exam)}
      disabled={toggling}
      aria-pressed={on}
      title={`Camera proctoring is ${on ? "on" : "off"} — click to turn ${on ? "off" : "on"}`}
      className={cn(
        "badge transition-colors disabled:cursor-wait disabled:opacity-60",
        on ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
           : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200"
      )}
    >
      {toggling
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : on ? <Video className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5" />}
      Camera {on ? "on" : "off"}
    </button>
  );
};

const ExamActions = ({ exam, compact, navigate, onDelete, onDuplicate, duplicating }) => (
  <div className={cn("flex gap-1", compact ? "flex-wrap" : "justify-end")}>
    {compact ? (
      <>
        <Button size="sm" variant="secondary" icon={Users} onClick={() => navigate(`/admin/exams/${exam._id}/attempts`)}>Attempts</Button>
        <Button size="sm" variant="secondary" icon={Pencil} onClick={() => navigate(`/admin/exams/${exam._id}/edit`)}>Edit</Button>
        <Button size="sm" variant="secondary" icon={Copy} loading={duplicating} onClick={() => onDuplicate(exam)}>Duplicate</Button>
        <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => onDelete(exam)}>Delete</Button>
      </>
    ) : (
      <>
        <IconButton icon={Users} label="View attempts" size="sm" onClick={() => navigate(`/admin/exams/${exam._id}/attempts`)} />
        <IconButton icon={Pencil} label="Edit exam" size="sm" onClick={() => navigate(`/admin/exams/${exam._id}/edit`)} />
        <IconButton icon={Copy} label="Duplicate exam" size="sm" loading={duplicating} onClick={() => onDuplicate(exam)} />
        <IconButton icon={Trash2} label="Delete exam" size="sm" variant="danger-ghost" onClick={() => onDelete(exam)} />
      </>
    )}
  </div>
);

// ═════════════════════════════════════════════════════════════════════════════
const ExamList = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const toast = useToast();
  const { list: exams, loading, error, actionLoading, actionError } = useSelector((s) => s.exams);

  useEffect(() => {
    const role  = localStorage.getItem("userRole");
    const dept  = localStorage.getItem("adminDepartment");
    const token = localStorage.getItem("token");
    if (!token || role !== "admin" || !dept) navigate("/");
    dispatch(clearActionError());
  }, []); // eslint-disable-line

  const adminDept = localStorage.getItem("adminDepartment") || "";

  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [togglingId,   setTogglingId]   = useState(null);
  const [duplicatingId, setDuplicatingId] = useState(null);
  const [duplicateTarget, setDuplicateTarget] = useState(null); // only set when a draft would be replaced

  useEffect(() => { if (actionError) toast(actionError, "error"); }, [actionError, toast]);
  useEffect(() => { dispatch(fetchExams()); }, [dispatch]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const subj = deleteTarget.subject;
    const res  = await dispatch(deleteExam(deleteTarget._id));
    if (res.meta.requestStatus === "fulfilled") {
      toast(`"${subj}" deleted.`);
      setDeleteTarget(null);
    }
  };

  // Quick ON/OFF for camera proctoring — reuses PUT /admin/exams/:id.
  // The updateExam reducer merges the response into the list, so the badge updates in place.
  // Duplicate: load the full exam (questions + answers), save it as the Create Exam
  // draft with an empty schedule, and open Create Exam to review and save the copy.
  const duplicateExam = async (exam) => {
    setDuplicateTarget(null);
    setDuplicatingId(exam._id);
    try {
      const res = await API.get(`/admin/exams/${exam._id}`);
      const full = res.data.exam;
      saveDraft({
        step: 1,
        examData: {
          subject:          `${full.subject} (copy)`,
          duration:         String(full.duration ?? ""),
          startTime:        "",   // old schedule has usually passed — admin picks a new one
          endTime:          "",
          marksPerQuestion: full.marksPerQuestion ?? 1,
          cameraEnabled:    full.cameraEnabled !== false,
          shuffleQuestions: full.shuffleQuestions === true,
        },
        sections: full.sections || [],
        questions: (full.questions || []).map((q) => ({
          id:            Date.now() + Math.random(),
          section:       q.section || null,
          text:          q.text,
          options:       [...q.options],
          correctAnswer: q.correctAnswer ?? null,
        })),
      });
      navigate("/admin/create-exam", { state: { duplicatedFrom: full.subject } });
    } catch (err) {
      toast(err.response?.data?.message || "Couldn't load the exam to duplicate.", "error");
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDuplicate = (exam) => {
    if (draftHasContent()) setDuplicateTarget(exam); // confirm before overwriting unsaved work
    else duplicateExam(exam);
  };

  const handleToggleCamera = async (exam) => {
    const next = exam.cameraEnabled === false;
    setTogglingId(exam._id);
    const res = await dispatch(updateExam({ id: exam._id, body: { cameraEnabled: next } }));
    setTogglingId(null);
    if (res.meta.requestStatus === "fulfilled") {
      toast(`Camera proctoring ${next ? "enabled" : "disabled"} for "${exam.subject}".`);
    }
  };

  const filtered = exams.filter((e) =>
    (statusFilter === "all" || e.status === statusFilter) &&
    (!search.trim() || e.subject.toLowerCase().includes(search.toLowerCase()))
  );

  const stats = {
    total:     exams.length,
    upcoming:  exams.filter((e) => e.status === "upcoming").length,
    active:    exams.filter((e) => e.status === "active").length,
    completed: exams.filter((e) => e.status === "completed").length,
  };

  const initialLoad = loading && exams.length === 0;
  const hasFilters = search || statusFilter !== "all";
  const clearFilters = () => { setSearch(""); setStatusFilter("all"); };

  return (
    <>
      <PageHeader
        title="Exams"
        description={`All exams for the ${adminDept} department. Times are shown in IST.`}
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh" variant="secondary" loading={loading} onClick={() => dispatch(fetchExams())} />
            <Button icon={Plus} onClick={() => navigate("/admin/create-exam")}>Create exam</Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total exams" value={stats.total}     icon={ClipboardList} loading={initialLoad} />
        <StatCard label="Upcoming"    value={stats.upcoming}  icon={CalendarClock} tone="info" loading={initialLoad} />
        <StatCard label="Live now"    value={stats.active}    icon={Radio}         tone="success" loading={initialLoad} />
        <StatCard label="Completed"   value={stats.completed} icon={CheckCircle2}  tone="neutral" loading={initialLoad} />
      </div>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by subject" className="lg:max-w-sm lg:flex-1" />
          <Tabs
            label="Filter by status"
            value={statusFilter}
            onChange={setStatusFilter}
            items={[
              { value: "all",       label: "All",       count: stats.total },
              { value: "active",    label: "Live",      count: stats.active },
              { value: "upcoming",  label: "Upcoming",  count: stats.upcoming },
              { value: "completed", label: "Completed", count: stats.completed },
            ]}
          />
          {hasFilters && <Button variant="ghost" icon={FilterX} onClick={clearFilters} className="lg:ml-auto">Clear</Button>}
        </div>

        {error && !exams.length ? (
          <ErrorState message={error} onRetry={() => dispatch(fetchExams())} />
        ) : initialLoad ? (
          <div className="space-y-3 p-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={hasFilters ? "No exams match your filters" : "No exams yet"}
            description={hasFilters ? "Try a different search or status." : "Create your first exam manually or from an Excel template."}
            action={hasFilters
              ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
              : <Button icon={Plus} onClick={() => navigate("/admin/create-exam")}>Create exam</Button>}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="table-wrap hidden xl:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Exam</th>
                    <th>Status</th>
                    <th>Proctoring</th>
                    <th>Questions</th>
                    <th>Marks</th>
                    <th>Duration</th>
                    <th>Schedule (IST)</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((exam) => {
                    const totalMarks = (exam.questionCount ?? 0) * (exam.marksPerQuestion ?? 1);
                    return (
                      <tr key={exam._id}>
                        <td>
                          <p className="max-w-[240px] truncate font-semibold text-slate-900">{exam.subject}</p>
                          <p className="text-xs text-slate-500">Created {formatDateIST(exam.createdAt)}</p>
                        </td>
                        <td><ExamStatusBadge status={exam.status} /></td>
                        <td><CameraChip exam={exam} toggling={togglingId === exam._id} onToggle={handleToggleCamera} /></td>
                        <td className="tabular">{exam.questionCount ?? 0}</td>
                        <td className="whitespace-nowrap">
                          <span className="font-semibold tabular text-slate-900">{totalMarks}</span>
                          <span className="ml-1 text-xs text-slate-500">({exam.marksPerQuestion ?? 1}/q)</span>
                        </td>
                        <td className="whitespace-nowrap tabular">{exam.duration} min</td>
                        <td className="whitespace-nowrap text-xs leading-5">
                          <span className="inline-block w-9 text-slate-500">Start</span><span className="text-slate-800">{formatDateTimeShortIST(exam.startTime)}</span><br />
                          <span className="inline-block w-9 text-slate-500">End</span><span className="text-slate-800">{formatDateTimeShortIST(exam.endTime)}</span>
                        </td>
                        <td><ExamActions exam={exam} navigate={navigate} onDelete={setDeleteTarget} onDuplicate={handleDuplicate} duplicating={duplicatingId === exam._id} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile / tablet cards */}
            <ul className="divide-y divide-slate-100 xl:hidden">
              {filtered.map((exam) => {
                const totalMarks = (exam.questionCount ?? 0) * (exam.marksPerQuestion ?? 1);
                return (
                  <li key={exam._id} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900">{exam.subject}</p>
                        <p className="text-xs text-slate-500">Created {formatDateIST(exam.createdAt)}</p>
                      </div>
                      <ExamStatusBadge status={exam.status} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge icon={ClipboardList}>{exam.questionCount ?? 0} questions</Badge>
                      <Badge icon={Star}>{totalMarks} marks</Badge>
                      <Badge icon={Clock}>{exam.duration} min</Badge>
                      <CameraChip exam={exam} toggling={togglingId === exam._id} onToggle={handleToggleCamera} />
                    </div>
                    <dl className="grid grid-cols-1 gap-1 rounded-lg bg-slate-50 px-3 py-2 text-xs sm:grid-cols-2">
                      <div><dt className="inline text-slate-500">Start: </dt><dd className="inline font-medium text-slate-800">{formatIST(exam.startTime)}</dd></div>
                      <div><dt className="inline text-slate-500">End: </dt><dd className="inline font-medium text-slate-800">{formatIST(exam.endTime)}</dd></div>
                    </dl>
                    <ExamActions exam={exam} compact navigate={navigate} onDelete={setDeleteTarget} onDuplicate={handleDuplicate} duplicating={duplicatingId === exam._id} />
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              Showing {filtered.length} of {exams.length} exam{exams.length !== 1 ? "s" : ""}
            </div>
          </>
        )}
      </Card>

      {duplicateTarget && (
        <ConfirmDialog
          tone="warning"
          title="Replace your unsaved draft?"
          message={<>You have an unsaved exam in Create Exam. Duplicating <strong className="text-slate-900">"{duplicateTarget.subject}"</strong> will replace it.</>}
          confirmLabel="Replace draft"
          onConfirm={() => duplicateExam(duplicateTarget)}
          onCancel={() => setDuplicateTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete exam?"
          message={<>Delete <strong className="text-slate-900">"{deleteTarget.subject}"</strong> and its questions. This cannot be undone.</>}
          confirmLabel={actionLoading ? "Deleting…" : "Delete exam"}
          loading={actionLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
};

export default ExamList;
