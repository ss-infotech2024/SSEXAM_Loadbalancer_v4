import React, { useState, useEffect, useMemo, useCallback } from "react";
import API from "@/services/api";
import {
  Download, RefreshCw, Users, TrendingUp, Percent, Trophy, SlidersHorizontal, ChevronDown, FilterX, Inbox,
} from "lucide-react";
import {
  PageHeader, Button, IconButton, StatCard, Card, Field, Input, Select, SearchInput, Badge, Avatar,
  ScoreBadge, PassFailBadge, EmptyState, ErrorState, Skeleton, Pagination,
} from "../../components/ui";
import { cn } from "../../utils/cn";
import { formatDateTimeShortIST } from "../../utils/time";
import SectionBreakdown from "../../components/exam/SectionBreakdown";

// ─── CSV helper ───────────────────────────────────────────────────────────────
const downloadCSV = (rows, filename) => {
  if (!rows.length) {
    alert("No data to download");
    return;
  }

  // Section names are admin-defined per exam: one score column per distinct name in these results
  const sectionNames = [];
  rows.forEach((r) => (r.sectionBreakdown || []).forEach((sb) => {
    if (!sectionNames.includes(sb.section)) sectionNames.push(sb.section);
  }));

  const headers = [
    "Student Name",
    "Roll Number",
    "Email",
    "College",
    "Exam",
    "Department",
    "Score",
    "Total Marks",
    "Percentage",
    "Grade",
    "Correct",
    "Wrong",
    "Skipped",
    ...sectionNames.map((n) => `${n} Score`),
    "Status",
    "Submitted At",
  ];

  const escape = (val) => {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csvContent = [
    headers.map(escape).join(","),
    ...rows.map((r) =>
      [
        r.student?.name || r.student?.fullName || "",
        r.student?.rollNumber || r.student?.studentId || "",
        r.student?.email || "",
        r.student?.college || "",
        r.exam?.subject || "",
        r.exam?.department || "",
        r.score ?? "",
        r.totalMarks ?? "",
        r.percentage ?? "",
        r.grade || "",
        r.correctCount ?? "",
        r.wrongCount ?? "",
        r.skippedCount ?? r.unansweredCount ?? "",
        ...sectionNames.map((n) => {
          const sb = r.sectionBreakdown?.find((x) => x.section === n);
          return sb ? `${sb.score}/${sb.totalMarks}` : "";
        }),
        (r.percentage ?? 0) >= 40 ? "Pass" : "Fail",
        r.submittedAt
          ? new Date(r.submittedAt).toLocaleString("en-IN")
          : "",
      ]
        .map(escape)
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const StudentScores = () => {
  const [adminDepartment, setAdminDepartment] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exams, setExams] = useState([]);

  // ── Filters ───────────────────────────────────────────────────────────────
  const [selectedExam, setSelectedExam] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [passFailFilter, setPassFailFilter] = useState(""); // "" | "pass" | "fail"
  const [minPercentage, setMinPercentage] = useState("");
  const [maxPercentage, setMaxPercentage] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [collegeFilter, setCollegeFilter] = useState("");

  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [showFilters, setShowFilters] = useState(true);

  // ── Fetch on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    const dept = localStorage.getItem("adminDepartment");
    const user = JSON.parse(localStorage.getItem("user") || "{}");

    if (dept) {
      setAdminDepartment(dept);
      fetchExams();
      fetchAllResults();
    } else if (user.department) {
      setAdminDepartment(user.department);
      fetchExams();
      fetchAllResults();
    } else {
      setError("Department not found. Please login again.");
      setLoading(false);
    }
  }, []);

  const fetchExams = async () => {
    try {
      const response = await API.get("/admin/exams");
      setExams(response.data.exams || []);
    } catch (err) {
      console.error("Error fetching exams:", err);
    }
  };

  const fetchAllResults = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await API.get("/admin/results");
      setResults(response.data.results || []);
    } catch (err) {
      console.error("Error fetching results:", err);
      setError(err.response?.data?.message || "Failed to load results");
    } finally {
      setLoading(false);
    }
  };

  const fetchExamResults = async (examId) => {
    if (!examId) {
      fetchAllResults();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await API.get(`/admin/results/exam/${examId}`);
      setResults(response.data.results || []);
    } catch (err) {
      console.error("Error fetching exam results:", err);
      setError(err.response?.data?.message || "Failed to load exam results");
    } finally {
      setLoading(false);
    }
  };

  const handleExamFilter = (examId) => {
    setSelectedExam(examId);
    setCurrentPage(1);
    if (examId) fetchExamResults(examId);
    else fetchAllResults();
  };

  // Unique colleges from results (if field exists)
  const colleges = useMemo(() => {
    const set = new Set();
    results.forEach((r) => {
      const c = r.student?.college;
      if (c) set.add(c);
    });
    return Array.from(set).sort();
  }, [results]);

  // Unique exam dates from existing exams
    const examDates = useMemo(() => {
      const dateMap = new Map();

      exams.forEach((exam) => {
        if (!exam.startTime) return;

        const date = new Date(exam.startTime);

        if (isNaN(date.getTime())) return;

        // YYYY-MM-DD for filtering
        const dateKey = date.toISOString().split("T")[0];

        // Display date
        const displayDate = date.toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });

        dateMap.set(dateKey, displayDate);
      });

      return Array.from(dateMap.entries())
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([value, label]) => ({
          value,
          label,
        }));
    }, [exams]);

  // ── Client-side filtering ─────────────────────────────────────────────────
  const filteredResults = useMemo(() => {
    return results.filter((result) => {
      const searchLower = searchTerm.toLowerCase().trim();
      const studentName = (
        result.student?.name ||
        result.student?.fullName ||
        ""
      ).toLowerCase();
      const rollNumber = String(
        result.student?.rollNumber || result.student?.studentId || ""
      ).toLowerCase();
      const examSubject = (result.exam?.subject || "").toLowerCase();
      const email = (result.student?.email || "").toLowerCase();

      const matchSearch =
        !searchLower ||
        studentName.includes(searchLower) ||
        rollNumber.includes(searchLower) ||
        examSubject.includes(searchLower) ||
        email.includes(searchLower);

      const pct = result.percentage ?? 0;
      const isPass = pct >= 40;

      const matchPassFail =
        !passFailFilter ||
        (passFailFilter === "pass" && isPass) ||
        (passFailFilter === "fail" && !isPass);

      const matchMinPct =
        minPercentage === "" || pct >= Number(minPercentage);
      const matchMaxPct =
        maxPercentage === "" || pct <= Number(maxPercentage);

      let matchDate = true;

      if (dateFrom || dateTo) {
        const examStartTime = result.exam?.startTime;
        const examDate = examStartTime ? new Date(examStartTime) : null;

        if (!examDate || isNaN(examDate.getTime())) {
          matchDate = false;
        } else {
          if (dateFrom) {
            const from = new Date(dateFrom);
            from.setHours(0, 0, 0, 0);

            if (examDate < from) {
              matchDate = false;
            }
          }

          if (dateTo) {
            const to = new Date(dateTo);
            to.setHours(23, 59, 59, 999);

            if (examDate > to) {
              matchDate = false;
            }
          }
        }
      }

      const matchCollege =
        !collegeFilter ||
        (result.student?.college || "") === collegeFilter;

      return (
        matchSearch &&
        matchPassFail &&
        matchMinPct &&
        matchMaxPct &&
        matchDate &&
        matchCollege
      );
    });
  }, [
    results,
    searchTerm,
    passFailFilter,
    minPercentage,
    maxPercentage,
    dateFrom,
    dateTo,
    collegeFilter,
  ]);

  // Filtered summary (for cards)
  const filteredSummary = useMemo(() => {
    if (!filteredResults.length) {
      return {
        totalResults: 0,
        averageScore: 0,
        passCount: 0,
        failCount: 0,
        passRate: 0,
        highestScore: 0,
        lowestScore: 0,
      };
    }
    const pcts = filteredResults.map((r) => r.percentage ?? 0);
    const passCount = pcts.filter((p) => p >= 40).length;
    const failCount = pcts.length - passCount;
    const avg =
      pcts.reduce((a, b) => a + b, 0) / pcts.length;
    return {
      totalResults: pcts.length,
      averageScore: Math.round(avg * 10) / 10,
      passCount,
      failCount,
      passRate: Math.round((passCount / pcts.length) * 1000) / 10,
      highestScore: Math.max(...pcts),
      lowestScore: Math.min(...pcts),
    };
  }, [filteredResults]);

  // Pagination
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedResults = filteredResults.slice(
    startIndex,
    startIndex + itemsPerPage
  );

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [
    searchTerm,
    passFailFilter,
    minPercentage,
    maxPercentage,
    dateFrom,
    dateTo,
    collegeFilter,
    selectedExam,
  ]);

  const clearFilters = () => {
    setSearchTerm("");
    setPassFailFilter("");
    setMinPercentage("");
    setMaxPercentage("");
    setDateFrom("");
    setDateTo("");
    setCollegeFilter("");
    setSelectedExam("");
    setCurrentPage(1);
    fetchAllResults();
  };

  const activeFilterCount = [
    searchTerm,
    passFailFilter,
    minPercentage,
    maxPercentage,
    dateFrom,
    dateTo,
    collegeFilter,
    selectedExam,
  ].filter(Boolean).length;

  // ── Download handlers ─────────────────────────────────────────────────────
  const handleDownloadAll = useCallback(() => {
    const name = selectedExam
      ? `results_exam_${selectedExam}_${Date.now()}.csv`
      : `all_results_${adminDepartment || "dept"}_${Date.now()}.csv`;
    downloadCSV(results, name);
  }, [results, selectedExam, adminDepartment]);

  const handleDownloadFiltered = useCallback(() => {
    const name = `filtered_results_${Date.now()}.csv`;
    downloadCSV(filteredResults, name);
  }, [filteredResults]);


  const refresh = selectedExam ? () => handleExamFilter(selectedExam) : fetchAllResults;
  const studentName = (r) => r.student?.name || r.student?.fullName || "Unknown student";
  const rollNo = (r) => r.student?.rollNumber || r.student?.studentId || "N/A";
  const submitted = (r) => r.submittedAt
    ? new Date(r.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "N/A";

  return (
    <>
      <PageHeader
        title="Results"
        description={`Submitted exam results for the ${adminDepartment || "…"} department. Pass mark is 40%.`}
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh" variant="secondary" loading={loading} onClick={refresh} />
            <Button variant="secondary" icon={Download} onClick={handleDownloadAll} disabled={!results.length}>
              Export all
            </Button>
            <Button icon={Download} onClick={handleDownloadFiltered} disabled={!filteredResults.length}>
              Export filtered ({filteredResults.length})
            </Button>
          </>
        }
      />

      {/* Stats — based on FILTERED data */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Results" value={filteredSummary.totalResults} icon={Users} loading={loading}
          hint={activeFilterCount > 0 ? `of ${results.length} total` : undefined}
        />
        <StatCard label="Average score" value={`${filteredSummary.averageScore}%`} icon={TrendingUp} tone="info" loading={loading} />
        <StatCard
          label="Pass rate" value={`${filteredSummary.passRate}%`} icon={Percent} tone="success" loading={loading}
          hint={`${filteredSummary.passCount} passed · ${filteredSummary.failCount} failed`}
        />
        <StatCard
          label="Highest score" value={`${filteredSummary.highestScore}%`} icon={Trophy} tone="warning" loading={loading}
          hint={`Lowest ${filteredSummary.lowestScore}%`}
        />
      </div>

      <Card>
        {/* Search + filter toggle */}
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search name, roll no., email or subject"
            className="sm:flex-1"
          />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={SlidersHorizontal}
              onClick={() => setShowFilters(!showFilters)}
              aria-expanded={showFilters}
              aria-controls="results-filters"
            >
              Filters
              {activeFilterCount > 0 && <Badge tone="brand" className="ml-0.5 px-1.5 py-0">{activeFilterCount}</Badge>}
              <ChevronDown className={cn("h-4 w-4 transition-transform", showFilters && "rotate-180")} aria-hidden="true" />
            </Button>
            {activeFilterCount > 0 && <Button variant="ghost" icon={FilterX} onClick={clearFilters}>Clear all</Button>}
          </div>
        </div>

        {showFilters && (
          <div id="results-filters" className="grid grid-cols-1 gap-4 border-b border-slate-100 bg-slate-50/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Exam">
              {(p) => (
                <Select {...p} value={selectedExam} onChange={(e) => handleExamFilter(e.target.value)}>
                  <option value="">All exams</option>
                  {exams.map((exam) => (
                    <option key={exam._id} value={exam._id}>
                      {exam.subject} ({exam.questionCount ?? "?"} Q)
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Result">
              {(p) => (
                <Select {...p} value={passFailFilter} onChange={(e) => setPassFailFilter(e.target.value)}>
                  <option value="">Pass and fail</option>
                  <option value="pass">Pass (≥ 40%)</option>
                  <option value="fail">Fail (&lt; 40%)</option>
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Min %">
                {(p) => <Input {...p} type="number" min="0" max="100" placeholder="0" value={minPercentage} onChange={(e) => setMinPercentage(e.target.value)} />}
              </Field>
              <Field label="Max %">
                {(p) => <Input {...p} type="number" min="0" max="100" placeholder="100" value={maxPercentage} onChange={(e) => setMaxPercentage(e.target.value)} />}
              </Field>
            </div>
            {colleges.length > 0 ? (
              <Field label="College">
                {(p) => (
                  <Select {...p} value={collegeFilter} onChange={(e) => setCollegeFilter(e.target.value)}>
                    <option value="">All colleges</option>
                    {colleges.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                )}
              </Field>
            ) : <div className="hidden lg:block" />}
            <Field label="Exam date from">
              {(p) => (
                <Select {...p} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}>
                  <option value="">Any date</option>
                  {examDates.map((date) => <option key={date.value} value={date.value}>{date.label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Exam date to">
              {(p) => (
                <Select {...p} value={dateTo} onChange={(e) => setDateTo(e.target.value)}>
                  <option value="">Any date</option>
                  {examDates.map((date) => <option key={date.value} value={date.value}>{date.label}</option>)}
                </Select>
              )}
            </Field>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={fetchAllResults} />
        ) : loading ? (
          <div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : filteredResults.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No results found"
            description={results.length === 0
              ? `No student results in the ${adminDepartment || "this"} department yet.`
              : "No results match your current filters."}
            action={activeFilterCount > 0 && <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="table-wrap hidden lg:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Exam</th>
                    <th>Score</th>
                    <th>Result</th>
                    <th>Grade</th>
                    <th>Answers</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedResults.map((result, index) => (
                    <tr key={result._id || index}>
                      <td>
                        <div className="flex items-center gap-3">
                          <Avatar name={studentName(result)} />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-900">{studentName(result)}</p>
                            <p className="font-mono text-xs text-slate-500">Roll {rollNo(result)}</p>
                            {result.student?.college && <p className="truncate text-xs text-slate-400">{result.student.college}</p>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <p className="max-w-[200px] truncate font-medium text-slate-900">{result.exam?.subject || "Unknown subject"}</p>
                        <p className="text-xs text-slate-500">{result.exam?.department}</p>
                      </td>
                      <td className="whitespace-nowrap font-semibold tabular text-slate-900">{result.score}/{result.totalMarks}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ScoreBadge percentage={result.percentage} />
                          <PassFailBadge percentage={result.percentage} />
                        </div>
                      </td>
                      <td className="font-semibold text-slate-900">{result.grade || "F"}</td>
                      <td className="whitespace-nowrap text-xs tabular">
                        <span className="font-semibold text-emerald-700" title="Correct">{result.correctCount || 0} ✓</span>{" "}
                        <span className="font-semibold text-rose-700" title="Wrong">{result.wrongCount || 0} ✗</span>{" "}
                        <span className="text-slate-500" title="Skipped">{result.skippedCount ?? result.unansweredCount ?? 0} skipped</span>
                        <SectionBreakdown breakdown={result.sectionBreakdown} compact className="mt-1.5" />
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">{result.submittedAt ? formatDateTimeShortIST(result.submittedAt) : "N/A"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile / tablet cards */}
            <ul className="divide-y divide-slate-100 lg:hidden">
              {paginatedResults.map((result, index) => (
                <li key={result._id || index} className="p-4">
                  <div className="flex items-start gap-3">
                    <Avatar name={studentName(result)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900">{studentName(result)}</p>
                      <p className="truncate text-xs text-slate-500">{result.exam?.subject} · Roll {rollNo(result)}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold tabular text-slate-900">{result.score}/{result.totalMarks}</p>
                      <p className="text-xs text-slate-500">Grade {result.grade || "F"}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ScoreBadge percentage={result.percentage} />
                    <PassFailBadge percentage={result.percentage} />
                    <span className="text-xs text-slate-500">
                      {result.correctCount || 0} correct · {result.wrongCount || 0} wrong · {submitted(result)}
                    </span>
                  </div>
                  <SectionBreakdown breakdown={result.sectionBreakdown} compact className="mt-2" />
                </li>
              ))}
            </ul>

            <Pagination page={currentPage} pageSize={itemsPerPage} total={filteredResults.length} onChange={setCurrentPage} />
          </>
        )}
      </Card>
    </>
  );
};

export default StudentScores;
