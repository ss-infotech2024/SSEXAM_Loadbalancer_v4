import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Award, CheckCircle2, XCircle, MinusCircle, FileText, CalendarDays, RefreshCw, Inbox, TrendingUp, Star } from "lucide-react";
import API from "@/services/api";
import { StudentLayout } from "../../components/student/StudentLayout";
import {
  PageHeader, IconButton, StatCard, Card, Badge, PassFailBadge, EmptyState, ErrorState, Skeleton,
} from "../../components/ui";
import { formatIST } from "../../utils/time";
import SectionBreakdown from "../../components/exam/SectionBreakdown";

const GRADE_LABEL = {
  'A+': "Outstanding", 'A': "Excellent", 'B+': "Very good", 'B': "Good", 'C': "Average", 'D': "Pass", 'F': "Fail",
};

// Score ring — colour follows the pass/fail band; the number and label carry the meaning.
const Ring = ({ pct }) => {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 34;
  const circ = 2 * Math.PI * r;
  const color = p >= 70 ? "#059669" : p >= 40 ? "#d97706" : "#e11d48";
  return (
    <div className="relative h-20 w-20 shrink-0" aria-hidden="true">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#e2e8f0" strokeWidth="7" />
        <circle cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${(p / 100) * circ} ${circ}`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-base font-bold tabular text-slate-900">{p}%</span>
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
const StudentResults = () => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Writes state only after the request settles (safe to call from the mount effect).
  const fetchResults = useCallback(async () => {
    // Same check as StudentDashboard
    const token = localStorage.getItem("token");
    const role = localStorage.getItem("userRole");

    if (!token || role !== "student") {
      setError("Please login as a student to view results.");
      setLoading(false);
      return;
    }

    try {
      const res = await API.get("/student/results");
      setResults(res.data.results || []);
      setError("");
    } catch (err) {
      console.error("Results fetch error:", err.response?.data || err);

      const msg = err.response?.data?.message || err.message || "Failed to load results";

      if (msg.toLowerCase().includes("access denied") || msg.includes("403")) {
        setError("You don't have permission to view results. Please make sure you are logged in with a student account.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  const loadResults = () => { setLoading(true); fetchResults(); };

  // Summary Stats
  const totalExams = results.length;
  const avgScore = totalExams > 0
    ? Math.round(results.reduce((sum, r) => sum + (r.percentage || 0), 0) / totalExams)
    : 0;
  const passed = results.filter(r => (r.percentage || 0) >= 40).length;
  const best = results.reduce((b, r) => (r.percentage || 0) > (b?.percentage || -1) ? r : b, null);

  return (
    <StudentLayout>
      <PageHeader
        title="My results"
        description="Scores for every exam you've submitted. The pass mark is 40%."
        actions={<IconButton icon={RefreshCw} label="Refresh results" variant="secondary" loading={loading} onClick={loadResults} />}
      />

      {error ? (
        <Card><ErrorState title="Couldn't load your results" message={error} onRetry={loadResults} /></Card>
      ) : loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      ) : results.length === 0 ? (
        <Card>
          <EmptyState
            icon={Inbox}
            title="No results yet"
            description="Results appear here as soon as you submit an exam."
            action={<Link to="/student/dashboard" className="btn btn-md btn-secondary">Go to my exams</Link>}
          />
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Exams taken"   value={totalExams}       icon={FileText} />
            <StatCard label="Average score" value={`${avgScore}%`}   icon={TrendingUp} tone="info" />
            <StatCard label="Passed"        value={`${passed} / ${totalExams}`} icon={CheckCircle2} tone="success" />
            <StatCard label="Best score"    value={best ? `${best.percentage}%` : "—"} hint={best?.subject} icon={Award} tone="warning" />
          </div>

          <ul className="space-y-3">
            {results.map(r => (
              <li key={r._id}>
                <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5">
                  <div className="flex items-center gap-4 sm:contents">
                    <Ring pct={r.percentage} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-slate-900">{r.subject}</h2>
                        <PassFailBadge percentage={r.percentage} />
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Submitted {formatIST(r.submittedAt)}
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                        <span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />{r.correctCount || 0} correct</span>
                        <span className="flex items-center gap-1.5"><XCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />{r.wrongCount || 0} wrong</span>
                        {r.skippedCount != null && (
                          <span className="flex items-center gap-1.5"><MinusCircle className="h-4 w-4 text-slate-400" aria-hidden="true" />{r.skippedCount} skipped</span>
                        )}
                        {r.marksPerQuestion != null && (
                          <span className="flex items-center gap-1.5"><Star className="h-4 w-4 text-slate-400" aria-hidden="true" />{r.marksPerQuestion} marks / question</span>
                        )}
                      </div>
                      <SectionBreakdown breakdown={r.sectionBreakdown} compact className="mt-2.5" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-3 sm:block sm:border-0 sm:pt-0 sm:text-right">
                    <div>
                      <p className="text-2xl font-bold tabular text-slate-900">{r.score}<span className="text-base font-medium text-slate-400"> / {r.totalMarks}</span></p>
                      <p className="text-xs text-slate-500">marks</p>
                    </div>
                    {r.grade && (
                      <Badge tone="brand" className="sm:mt-2">Grade {r.grade}{GRADE_LABEL[r.grade] ? ` · ${GRADE_LABEL[r.grade]}` : ""}</Badge>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </StudentLayout>
  );
};

export default StudentResults;
