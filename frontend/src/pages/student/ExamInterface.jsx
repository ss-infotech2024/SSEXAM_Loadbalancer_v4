import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Clock, AlertCircle, Flag, ChevronLeft, ChevronRight, AlertTriangle, ShieldCheck, Users, Video, VideoOff,
  CheckCircle2, XCircle, Download, Home, Eye, EyeOff, UserCheck, UserX, Camera, CameraOff, Play,
  LayoutGrid, Send, Maximize, Loader2, RefreshCw, Timer, X,
} from "lucide-react";
import API from "@/services/api";
import { Button, Modal, Badge } from "../../components/ui";
import { cn } from "../../utils/cn";
import SectionBreakdown from "../../components/exam/SectionBreakdown";

// Exam requests keep their own timeout (applied per request on the shared API instance)
const EXAM_REQUEST_TIMEOUT = 30000;

// ─── Script loader ─────────────────────────────────────────────────────────
const loadScript = (src) =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });

// ─── Constants ──────────────────────────────────────────────────────────────
const FACEAPI_CDN           = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
const WEIGHTS_URL           = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
const VIOLATION_COOLDOWN_MS = 7000;
const DETECTION_INTERVAL_MS = 1500;
const MAX_WARNINGS          = 5;

// ══════════════════════════════════════════════════════════════════════════════
const ExamInterface = ({ exam, onExamEnd = () => {} }) => {
  const navigate = useNavigate();

  // ── state ──────────────────────────────────────────────────────────────────
  const [questions,         setQuestions]         = useState([]);
  const [currentQuestion,   setCurrentQuestion]   = useState(0);
  const [answers,           setAnswers]           = useState({});  // { questionIndex: optionIndex }
  const [markedForReview,   setMarkedForReview]   = useState([]);
  const [timeRemaining,     setTimeRemaining]     = useState(0);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting,        setSubmitting]        = useState(false);
  const [showWarning,       setShowWarning]       = useState(false);
  const [warningMessage,    setWarningMessage]    = useState("");

  // phase: "loading" | "fetching" | "preflight" | "running" | "result" | "error"
  const [phase,       setPhase]       = useState("loading");
  const [loadError,   setLoadError]   = useState("");
  const [fetchStatus, setFetchStatus] = useState("Initialising...");
  const [camStatus,   setCamStatus]   = useState("idle");
  // Per-exam camera proctoring — undefined (older exams) means ON
  const [cameraEnabled, setCameraEnabled] = useState(exam?.cameraEnabled !== false);

  // proctoring
  const [cameraActive,     setCameraActive]     = useState(false);
  const [cameraError,      setCameraError]      = useState("");
  const [modelStatus,      setModelStatus]      = useState("loading");
  const [faceDetected,     setFaceDetected]     = useState(true);
  const [multipleFaces,    setMultipleFaces]    = useState(false);
  const [eyesOpen,         setEyesOpen]         = useState(true);
  const [lookingAway,      setLookingAway]      = useState(false);
  const [warnings,         setWarnings]         = useState(0);
  const [violationHistory, setViolationHistory] = useState([]);

  // result — from server
  const [resultData, setResultData] = useState(null);
  // Marks per question for display (from GET /student/exams/:id)
  const [marksPerQ, setMarksPerQ] = useState(exam?.marksPerQuestion || 1);
  // Mobile question palette
  const [showPalette, setShowPalette] = useState(false);

  // ── refs ───────────────────────────────────────────────────────────────────
  const videoRef             = useRef(null);
  const canvasRef            = useRef(null);
  const streamRef            = useRef(null);
  const detectionIntervalRef = useRef(null);
  const timerIntervalRef     = useRef(null);
  const warningTimerRef      = useRef(null);
  const warningsRef          = useRef(0);
  const lastViolationTimeRef = useRef(0);
  const examEndedRef         = useRef(false);
  const cameraActiveRef      = useRef(false);
  const submitInProgress     = useRef(false);
  const isMountedRef         = useRef(true);
  const faceAbsenceCount     = useRef(0);

  // Live refs — prevent stale closures in timer / detection callbacks
  const questionsRef        = useRef([]);
  const answersRef          = useRef({});
  const timeRemainingRef    = useRef(0);
  const violationHistoryRef = useRef([]);

  useEffect(() => { questionsRef.current        = questions;        }, [questions]);
  useEffect(() => { answersRef.current          = answers;          }, [answers]);
  useEffect(() => { timeRemainingRef.current    = timeRemaining;    }, [timeRemaining]);
  useEffect(() => { warningsRef.current         = warnings;         }, [warnings]);
  useEffect(() => { violationHistoryRef.current = violationHistory; }, [violationHistory]);
  useEffect(() => () => { isMountedRef.current  = false; },          []);

  // ── formatters ─────────────────────────────────────────────────────────────
  const fmt = (s) => {
    if (s == null) return "00:00:00";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  const fmtTaken = (s) => {
    if (s == null) return "0s";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  // ── Stop camera helper ─────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current       = null;
    cameraActiveRef.current = false;
    setCameraActive(false);
  }, []);

  // ── stopAll — called before submit / terminate ─────────────────────────────
  const stopAll = useCallback(() => {
    if (timerIntervalRef.current)     clearInterval(timerIntervalRef.current);
    if (detectionIntervalRef.current) clearInterval(detectionIntervalRef.current);
    timerIntervalRef.current     = null;
    detectionIntervalRef.current = null;
    stopCamera();
    window.__examCleanup?.();
  }, [stopCamera]);

  // ────────────────────────────────────────────────────────────────────────────
  // API SUBMIT  (pattern from reference code)
  // Formats answers as { questionId, selectedOption } per question,
  // POSTs to /student/exams/:id/submit, shows server result.
  // ────────────────────────────────────────────────────────────────────────────
  const submitExam = useCallback(async (isAuto = false, terminationReason = "") => {
    if (submitInProgress.current || examEndedRef.current) return;
    submitInProgress.current = true;
    examEndedRef.current     = true;
    setSubmitting(true);
    stopAll();

    const qs  = questionsRef.current;
    const ans = answersRef.current;

    // Build answer array — one entry per question, keyed by question._id
    const formattedAnswers = qs.map((q, index) => ({
      questionId:     q._id || q.id,
      selectedOption: ans[index] !== undefined ? ans[index] : null,
    }));

    const payload = {
      answers: formattedAnswers,
      ...(isAuto && {
        terminatedBy:       "proctor",
        terminationReason,
      }),
    };

    try {
      const res  = await API.post(`/student/exams/${exam._id}/submit`, payload, { timeout: EXAM_REQUEST_TIMEOUT });
      const data = res.data.result || res.data;

      const timeTaken = ((exam?.duration || 60) * 60) - timeRemainingRef.current;

      setResultData({
        // server-provided fields
        score:           data.score           ?? data.obtainedMarks ?? 0,
        totalMarks:      data.totalMarks      ?? 0,
        percentage:      data.percentage      ?? 0,
        correctCount:    data.correctCount    ?? 0,
        wrongCount:      data.wrongCount      ?? data.incorrectCount ?? 0,
        unansweredCount: data.unansweredCount
          ?? (qs.length - (data.correctCount ?? 0) - (data.wrongCount ?? data.incorrectCount ?? 0)),
        sectionBreakdown: data.sectionBreakdown ?? [],
        // local extras
        subject:          exam?.subject || exam?.title,
        timeTaken,
        violations:       warningsRef.current,
        violationHistory: violationHistoryRef.current,
        submittedAt:      new Date().toLocaleString(),
        isAuto,
        terminationReason,
      });

      setPhase("result");
      // onExamEnd() runs when the student leaves the result screen — calling it here
      // made the parent unmount this component before the result could be seen.
    } catch (err) {
      console.error("[submit]", err);
      alert(err.response?.data?.message || "Failed to submit exam. Please try again.");
      // Allow retry — roll back guard flags
      examEndedRef.current     = false;
      submitInProgress.current = false;
      setSubmitting(false);
      setPhase("running");
    }
  }, [exam, stopAll]);

  // ── Violation handler ──────────────────────────────────────────────────────
  const handleViolation = useCallback((reason) => {
    if (examEndedRef.current) return;
    const now = Date.now();
    if (now - lastViolationTimeRef.current < VIOLATION_COOLDOWN_MS) return;
    lastViolationTimeRef.current = now;

    const newCount = warningsRef.current + 1;
    setWarningMessage(`Warning ${newCount}/${MAX_WARNINGS}: ${reason}`);
    setShowWarning(true);
    clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setShowWarning(false);
    }, 4500);

    setWarnings(newCount);
    warningsRef.current = newCount;
    setViolationHistory((prev) => {
      const next = [...prev, { reason, time: now }];
      violationHistoryRef.current = next;
      return next;
    });

    if (newCount >= MAX_WARNINGS) {
      examEndedRef.current = true;
      setTimeout(() => submitExam(true, `Too many violations. Last: ${reason}`), 600);
    }
  }, [submitExam]);

  // ── face-api detection ─────────────────────────────────────────────────────
  const runFaceAPIDetection = useCallback(async () => {
    const faceapi = window.faceapi;
    const video   = videoRef.current;
    if (!video || !faceapi || !cameraActiveRef.current || video.readyState < 2) return;
    try {
      const opts       = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
      const detections = await faceapi.detectAllFaces(video, opts).withFaceLandmarks();

      const canvas = canvasRef.current;
      if (canvas && video.videoWidth) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        faceapi.draw.drawDetections(canvas, detections);
        faceapi.draw.drawFaceLandmarks(canvas, detections);
      }

      if (detections.length === 0) {
        setFaceDetected(false); setMultipleFaces(false); setEyesOpen(false); setLookingAway(false);
        faceAbsenceCount.current++;
        if (faceAbsenceCount.current >= 2) {
          handleViolation("No face detected — position your face in front of the camera");
          faceAbsenceCount.current = 0;
        }
        return;
      }
      faceAbsenceCount.current = 0;

      if (detections.length > 1) {
        setFaceDetected(true); setMultipleFaces(true); setLookingAway(false);
        handleViolation("Multiple faces detected — only you should be visible");
        return;
      }
      setFaceDetected(true); setMultipleFaces(false);

      const det     = detections[0];
      const box     = det.detection.box;
      const vw      = video.videoWidth  || 640;
      const vh      = video.videoHeight || 480;
      const cx      = (box.x + box.width  / 2) / vw;
      const cy      = (box.y + box.height / 2) / vh;
      const ratio   = (box.width * box.height) / (vw * vh);
      const centred = cx > 0.25 && cx < 0.75 && cy > 0.18 && cy < 0.82;
      const propDist = ratio > 0.04 && ratio < 0.45;

      if (!centred || !propDist) {
        setLookingAway(true);
        handleViolation(!centred ? "Looking away — please face the camera" : "Adjust your distance from the camera");
      } else { setLookingAway(false); }

      if (det.landmarks) {
        const le = det.landmarks.getLeftEye();
        const re = det.landmarks.getRightEye();
        if (le?.length >= 6 && re?.length >= 6) {
          const eyeH = (p) => Math.abs(((p[1]?.y + p[2]?.y) / 2) - ((p[4]?.y + p[5]?.y) / 2));
          const eyeW = (p) => Math.abs(p[0]?.x - p[3]?.x) || 1;
          if (eyeH(le) / eyeW(le) < 0.15 && eyeH(re) / eyeW(re) < 0.15) {
            setEyesOpen(false);
            handleViolation("Eyes appear closed — please keep your eyes open");
          } else { setEyesOpen(true); }
        }
      }
    } catch (err) { console.error("[face-api]", err); }
  }, [handleViolation]);

  // ── Motion fallback ────────────────────────────────────────────────────────
  const runMotionDetection = useCallback(() => {
    const video = videoRef.current;
    if (!video || !cameraActiveRef.current || video.readyState < 2) return;
    const tmp = document.createElement("canvas");
    tmp.width = 160; tmp.height = 120;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(video, 0, 0, 160, 120);
    const frame = ctx.getImageData(0, 0, 160, 120);
    let skin = 0, total = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
      total++;
      if (r > 60 && g > 40 && b < 200 && r > g && r > b && Math.abs(r - g) > 10) skin++;
    }
    const hasFace = skin / total > 0.08;
    setFaceDetected(hasFace);
    if (!hasFace) {
      faceAbsenceCount.current++;
      if (faceAbsenceCount.current >= 3) {
        handleViolation("No face detected — ensure your face is visible");
        faceAbsenceCount.current = 0;
      }
    } else { faceAbsenceCount.current = 0; }
  }, [handleViolation]);

  const startDetection = useCallback((useFaceAPI) => {
    if (detectionIntervalRef.current) clearInterval(detectionIntervalRef.current);
    detectionIntervalRef.current = setInterval(
      useFaceAPI ? runFaceAPIDetection : runMotionDetection,
      DETECTION_INTERVAL_MS
    );
  }, [runFaceAPIDetection, runMotionDetection]);

  // ── STEP 1: Fetch exam ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!exam?._id) { setLoadError("Invalid exam ID"); setPhase("error"); return; }
    setPhase("fetching");
    setFetchStatus("Fetching exam questions...");

    let retryTimer;
    const load = (attempt = 0) => API.get(`/student/exams/${exam._id}`, { timeout: EXAM_REQUEST_TIMEOUT })
      .then((res) => {
        if (!isMountedRef.current) return;
        const data = res.data.exam || res.data.data || res.data;
        if (!data?.questions) throw new Error("Invalid exam data");
        const qs  = data.questions || [];
        const dur = (data.duration || exam.duration || 60) * 60;
        setQuestions(qs);
        questionsRef.current     = qs;
        setCameraEnabled((data.cameraEnabled ?? exam.cameraEnabled) !== false);
        setTimeRemaining(dur);
        setMarksPerQ(data.marksPerQuestion ?? exam.marksPerQuestion ?? 1);
        timeRemainingRef.current = dur;
        setFetchStatus("Ready to begin!");
        setPhase("preflight");
      })
      .catch((err) => {
        if (!isMountedRef.current) return;
        // AI exam: the paper is still being generated (by this or another student's request) → keep trying
        if (((err.response?.status === 503 && err.response?.data?.retry) || err.code === "ECONNABORTED") && attempt < 45) {
          setFetchStatus("Preparing your questions, please wait...");
          retryTimer = setTimeout(() => load(attempt + 1), 4000);
          return;
        }
        if (err.response?.status === 401) {
          localStorage.removeItem("token");
          setTimeout(() => navigate("/"), 1500);
          setLoadError("Session expired. Redirecting...");
        } else {
          setLoadError(err.response?.data?.message || "Failed to load exam. Please retry.");
        }
        setPhase("error");
      });
    load();
    return () => clearTimeout(retryTimer);
  }, [exam, navigate]);

  // ── FIX A: Re-attach camera stream when video DOM node remounts ────────────
  // When phase switches preflight → running, the <video> element unmounts and a
  // brand-new one mounts. We must re-assign srcObject to the new element.
  useEffect(() => {
    if (phase !== "running") return;
    const vid = videoRef.current;
    if (!vid || !streamRef.current) return;
    if (vid.srcObject !== streamRef.current) {
      vid.srcObject = streamRef.current;
      vid.play().catch(() => {});
    }
  }, [phase]);

  // ── FIX B: Timer — reads/writes via ref, never captures stale state ────────
  useEffect(() => {
    if (phase !== "running") return;
    if (timerIntervalRef.current) return; // already running

    timerIntervalRef.current = setInterval(() => {
      if (examEndedRef.current) { clearInterval(timerIntervalRef.current); return; }
      setTimeRemaining((prev) => {
        const next = prev - 1;
        timeRemainingRef.current = next;
        if (next <= 0) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
          if (!examEndedRef.current) {
            examEndedRef.current = true;
            setTimeout(() => submitExam(true, "Time expired"), 100);
          }
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    };
  }, [phase, submitExam]);

  // ── Heartbeat — tells the admin "All students" page this student is live ───
  useEffect(() => {
    if (phase !== "running" || !exam?._id) return;
    const beat = () => {
      if (examEndedRef.current) return;
      API.post(`/student/exams/${exam._id}/heartbeat`).catch(() => {});
    };
    beat();
    const id = setInterval(beat, 30000);
    return () => clearInterval(id);
  }, [phase, exam?._id]);

  // ── STEP 2: User clicks "Start Exam" ──────────────────────────────────────
  const handleStartExam = useCallback(async () => {
    // Camera OFF for this exam → no getUserMedia, no face-api, no detection loop.
    // Fullscreen / tab / key / right-click checks below still run.
    if (cameraEnabled) {
      setCamStatus("requesting");
      setFetchStatus("Requesting camera access...");

      // Camera — MUST be inside a user-gesture handler
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
        streamRef.current = stream;
        const vid = videoRef.current;
        if (vid) {
          vid.srcObject = stream;
          await new Promise((resolve, reject) => {
            if (vid.readyState >= 2) { vid.play().then(resolve).catch(reject); return; }
            vid.onloadedmetadata = () => vid.play().then(resolve).catch(reject);
            vid.onerror = reject;
          });
          cameraActiveRef.current = true;
          setCameraActive(true);
          setCameraError("");
          setCamStatus("ok");
        }
      } catch (err) {
        console.error("[camera]", err);
        cameraActiveRef.current = false;
        const denied = err.name === "NotAllowedError";
        setCamStatus(denied ? "denied" : "error");
        setCameraError(
          denied         ? "Camera permission denied. Allow camera in browser settings and retry."
          : err.name === "NotFoundError" ? "No camera found on this device."
          : "Camera unavailable — exam will continue without proctoring."
        );
        setCameraActive(false);
      }

      // face-api models
      setFetchStatus("Loading AI proctoring models...");
      try {
        await loadScript(FACEAPI_CDN);
        if (window.faceapi) {
          await window.faceapi.nets.tinyFaceDetector.loadFromUri(WEIGHTS_URL);
          await window.faceapi.nets.faceLandmark68Net.loadFromUri(WEIGHTS_URL);
          setModelStatus("ready");
          startDetection(true);
        } else throw new Error("faceapi not on window");
      } catch (err) {
        console.warn("[face-api] fallback:", err.message);
        setModelStatus("fallback");
        startDetection(false);
      }
    }

    // Security hooks
    const goFS  = () => document.documentElement.requestFullscreen?.().catch(() => {});
    goFS();
    const onFS  = () => { if (!document.fullscreenElement && !examEndedRef.current) { handleViolation("Exited fullscreen"); goFS(); } };
    const onVis = () => { if (document.hidden && !examEndedRef.current) handleViolation("Tab switched — do not switch tabs during exam"); };
    const onKey = (e) => {
      if (["Escape","F11"].includes(e.key) || (e.ctrlKey && ["w","r","t"].includes(e.key)) || (e.altKey && e.key === "Tab"))
        { e.preventDefault(); handleViolation("Forbidden key combination detected"); }
    };
    const onCtx = (e) => { e.preventDefault(); handleViolation("Right-click detected"); };

    document.addEventListener("fullscreenchange", onFS);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("keydown", onKey);
    document.addEventListener("contextmenu", onCtx);

    window.__examCleanup = () => {
      document.removeEventListener("fullscreenchange", onFS);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("contextmenu", onCtx);
      document.exitFullscreen?.().catch(() => {});
    };

    // Switch to running — camera re-attach effect fires automatically
    setPhase("running");
  }, [cameraEnabled, startDetection, handleViolation]);

  // ── Global cleanup ─────────────────────────────────────────────────────────
  useEffect(() => () => {
    isMountedRef.current = false;
    stopAll();
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
  }, [stopAll]);

  // ── Display-only fullscreen indicator (the violation logic lives in handleStartExam) ──
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ── derived ────────────────────────────────────────────────────────────────
  const answeredCount   = Object.keys(answers).length;
  const markedCount     = markedForReview.length;
  const unansweredCount = questions.length - answeredCount;
  const currentQ        = questions[currentQuestion];
  const progress        = questions.length ? (answeredCount / questions.length) * 100 : 0;
  const timeTone        = timeRemaining < 300 ? "danger" : timeRemaining < 600 ? "warning" : "normal";
  const isMarked        = markedForReview.includes(currentQuestion);
  const examTitle       = exam?.subject || exam?.title || "Exam";

  // Sections are named by the admin per exam. Older exams have none → one unnamed group.
  const sectionGroups = (() => {
    const order = [];
    const byName = {};
    questions.forEach((q, i) => {
      const name = q.section || null;
      if (!(name in byName)) { byName[name] = []; order.push(name); }
      byName[name].push(i);
    });
    return order.map((name) => ({
      name,
      indexes: byName[name],
      answered: byName[name].filter((i) => answers[i] !== undefined).length,
    }));
  })();
  const hasSections    = sectionGroups.some((g) => g.name);
  const currentSection = currentQ?.section || null;

  const toggleMark = () =>
    setMarkedForReview((prev) => prev.includes(currentQuestion) ? prev.filter((i) => i !== currentQuestion) : [...prev, currentQuestion]);

  const selectOption = (i) => {
    const next = { ...answers, [currentQuestion]: i };
    setAnswers(next);
    answersRef.current = next;
  };

  const leaveExam = () => onExamEnd(resultData);

  // Single headline for the proctoring state (detail list is in the side panel)
  const proctor = !cameraEnabled
    ? { tone: "neutral", icon: VideoOff,      label: "Camera off for this exam" }
    : !cameraActive
    ? { tone: "danger",  icon: CameraOff,     label: "Camera unavailable" }
    : multipleFaces
    ? { tone: "danger",  icon: Users,         label: "Multiple faces" }
    : !faceDetected
    ? { tone: "danger",  icon: UserX,         label: "Face not detected" }
    : lookingAway
    ? { tone: "warning", icon: AlertTriangle, label: "Look at the screen" }
    : !eyesOpen
    ? { tone: "warning", icon: EyeOff,        label: "Eyes appear closed" }
    : { tone: "success", icon: ShieldCheck,   label: "Proctoring active" };

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: loading / fetching
  if (phase === "loading" || phase === "fetching") {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas p-6">
        <div className="text-center" role="status">
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-brand-600" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-700">{fetchStatus}</p>
        </div>
      </div>
    );
  }

  // SCREEN: error
  if (phase === "error") {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas p-6">
        <div className="card w-full max-w-md p-8 text-center" role="alert">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <AlertTriangle className="h-6 w-6" />
          </span>
          <h2 className="text-lg font-bold text-slate-900">Couldn't load the exam</h2>
          <p className="mt-1 text-sm text-slate-500">{loadError}</p>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="secondary" icon={Home} onClick={() => onExamEnd()}>Back to dashboard</Button>
            <Button icon={RefreshCw} onClick={() => window.location.reload()}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: preflight
  if (phase === "preflight") {
    const camFailed = camStatus === "denied" || camStatus === "error";
    return (
      <div className="fixed inset-0 z-[60] overflow-y-auto bg-canvas">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-4 py-8 sm:px-6">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium text-brand-700">System check</p>
              <h1 className="truncate text-xl font-bold text-slate-900">{examTitle}</h1>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            {/* Camera preview — videoRef lives here so the stream attaches on click */}
            <div className="lg:col-span-3">
              {cameraEnabled ? (
                <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-slate-200 bg-slate-900 shadow-card">
                  <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
                  <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100" />
                  {!cameraActive && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/90 px-6 text-center">
                      {camStatus === "requesting" ? (
                        <><Loader2 className="h-8 w-8 animate-spin text-brand-300" /><span className="text-sm text-slate-300">Requesting camera…</span></>
                      ) : camFailed ? (
                        <><CameraOff className="h-8 w-8 text-rose-300" /><span className="text-sm text-rose-200">{cameraError}</span></>
                      ) : (
                        <><Camera className="h-8 w-8 text-slate-400" /><span className="text-sm text-slate-300">Your camera preview will appear here</span></>
                      )}
                    </div>
                  )}
                  {cameraActive && (
                    <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-xs font-semibold text-white">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> LIVE
                    </span>
                  )}
                </div>
              ) : (
                <div className="card flex aspect-[4/3] flex-col items-center justify-center gap-3 p-6 text-center">
                  <VideoOff className="h-9 w-9 text-slate-400" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-700">Camera proctoring is disabled for this exam</p>
                  <p className="max-w-xs text-xs text-slate-500">Fullscreen, tab-switch and keyboard monitoring still apply.</p>
                </div>
              )}
            </div>

            {/* Summary + start */}
            <div className="card flex flex-col p-5 lg:col-span-2">
              <h2 className="text-lg font-bold text-slate-900">Ready to begin?</h2>
              <p className="mt-1 text-sm text-slate-500">
                {questions.length} questions · {exam?.duration || 60} minutes ·{" "}
                {cameraEnabled ? "the camera starts when you click Start." : "fullscreen starts when you click Start."}
              </p>

              <ul className="mt-5 space-y-2.5 text-sm text-slate-700">
                {[
                  cameraEnabled && "Sit in a well-lit place with your face clearly visible",
                  cameraEnabled && "No one else should appear in the camera frame",
                  "Don't switch tabs or leave fullscreen",
                  cameraEnabled && "Keep your eyes open and face the screen",
                  `The exam submits automatically after ${MAX_WARNINGS} warnings`,
                ].filter(Boolean).map((rule) => (
                  <li key={rule} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />{rule}
                  </li>
                ))}
              </ul>

              {camFailed && (
                <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  Camera access failed. You can retry, or continue without camera proctoring.
                </p>
              )}

              <div className="mt-auto space-y-2 pt-6">
                <Button
                  size="lg"
                  fullWidth
                  icon={Play}
                  onClick={handleStartExam}
                  loading={camStatus === "requesting"}
                >
                  {camStatus === "requesting" ? "Preparing…" : "Start exam"}
                </Button>
                {camFailed && (
                  <Button variant="secondary" fullWidth onClick={handleStartExam}>Continue without camera</Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: result (data from server)
  if (phase === "result" && resultData) {
    const pct  = parseFloat(resultData.percentage) || 0;
    const pass = pct >= 40;
    const r = 52;
    const circ = 2 * Math.PI * r;
    const ringColor = pct >= 70 ? "#059669" : pass ? "#d97706" : "#e11d48";

    return (
      <div className="fixed inset-0 z-[60] overflow-y-auto bg-canvas">
        <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-4 py-10">
          <div className="card animate-scale-in overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-5 text-center">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{resultData.subject}</p>
              <h1 className="mt-1 text-xl font-bold text-slate-900">Exam submitted</h1>
              {resultData.isAuto && (
                <p className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5" /> Auto-submitted · {resultData.terminationReason}
                </p>
              )}
            </div>

            <div className="px-6 py-8">
              <div className="flex flex-col items-center">
                <div className="relative h-36 w-36">
                  <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
                    <circle cx="60" cy="60" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
                    <circle cx="60" cy="60" r={r} fill="none" stroke={ringColor} strokeWidth="10" strokeLinecap="round"
                      strokeDasharray={`${(Math.min(pct, 100) / 100) * circ} ${circ}`} />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-mono text-2xl font-bold tabular text-slate-900">{pct}%</span>
                  </div>
                </div>
                <p className="mt-4 text-lg font-bold tabular text-slate-900">{resultData.score} / {resultData.totalMarks} marks</p>
                <div className="mt-2">
                  <Badge tone={pass ? "success" : "danger"} icon={pass ? CheckCircle2 : XCircle}>
                    {pass ? "Passed" : "Below pass mark (40%)"}
                  </Badge>
                </div>
              </div>

              <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Correct",    val: resultData.correctCount,         Icon: CheckCircle2, ic: "text-emerald-600" },
                  { label: "Wrong",      val: resultData.wrongCount,           Icon: XCircle,      ic: "text-rose-600" },
                  { label: "Unanswered", val: resultData.unansweredCount,      Icon: AlertCircle,  ic: "text-slate-400" },
                  { label: "Time taken", val: fmtTaken(resultData.timeTaken),  Icon: Timer,        ic: "text-brand-600" },
                ].map(({ label, val, Icon, ic }) => (
                  <div key={label} className="rounded-lg border border-slate-200 px-3 py-3">
                    <dt className="flex items-center gap-1.5 text-xs text-slate-500"><Icon className={cn("h-3.5 w-3.5", ic)} aria-hidden="true" />{label}</dt>
                    <dd className="mt-1 font-mono text-xl font-bold tabular text-slate-900">{val}</dd>
                  </div>
                ))}
              </dl>

              <SectionBreakdown breakdown={resultData.sectionBreakdown} className="mt-6 rounded-lg border border-slate-200 px-4 py-4" />

              {violationHistory.length > 0 && (
                <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-sm font-semibold text-amber-900">Proctoring warnings ({resultData.violations}/{MAX_WARNINGS})</p>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-amber-900">
                    {violationHistory.map((v, i) => <li key={i}>• {v.reason}</li>)}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                icon={Download}
                onClick={() => {
                  const txt = `EXAM RESULT\n${resultData.subject}\n${resultData.submittedAt}\n\nScore: ${resultData.score}/${resultData.totalMarks} (${pct}%)\nCorrect: ${resultData.correctCount} | Wrong: ${resultData.wrongCount} | Unanswered: ${resultData.unansweredCount}\nViolations: ${resultData.violations}/${MAX_WARNINGS}`;
                  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt])); a.download = `result-${Date.now()}.txt`; a.click();
                }}
              >
                Download summary
              </Button>
              <Button icon={Home} onClick={leaveExam}>Back to dashboard</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentQ && questions.length > 0) return null;

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: running exam

  const timerCls = {
    normal:  "border-slate-200 bg-white text-slate-900",
    warning: "border-amber-300 bg-amber-50 text-amber-900",
    danger:  "border-rose-300 bg-rose-50 text-rose-700",
  }[timeTone];

  const proctorCls = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger:  "border-rose-200 bg-rose-50 text-rose-700",
    neutral: "border-slate-200 bg-slate-50 text-slate-600",
  }[proctor.tone];
  const ProctorIcon = proctor.icon;

  const questionGrid = (
    <>
      <div className="space-y-4">
        {sectionGroups.map((g) => (
          <div key={g.name || "all"}>
            {hasSections && (
              <p className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-700">
                <span>{g.name || "Other"}</span>
                <span className="font-mono font-normal tabular text-slate-500">{g.answered}/{g.indexes.length}</span>
              </p>
            )}
            <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 lg:grid-cols-5">
              {g.indexes.map((i) => {
                const isCurrent = i === currentQuestion;
                const answered = answers[i] !== undefined;
                const marked = markedForReview.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { setCurrentQuestion(i); setShowPalette(false); }}
                    aria-label={`${g.name ? g.name + ", " : ""}Question ${i + 1}${answered ? ", answered" : ", not answered"}${marked ? ", marked for review" : ""}`}
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                      "relative h-9 rounded-md text-xs font-semibold tabular transition-colors",
                      answered ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : marked ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
                        : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
                      isCurrent && "ring-2 ring-brand-600 ring-offset-2"
                    )}
                  >
                    {i + 1}
                    {marked && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-amber-500" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-emerald-600" />Answered</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-amber-100 ring-1 ring-amber-300" />Marked</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-slate-300 bg-white" />Not answered</span>
      </div>
    </>
  );

  const counts = (
    <div className="grid grid-cols-3 gap-2 text-center">
      {[
        { val: answeredCount,   label: "Answered" },
        { val: markedCount,     label: "Marked" },
        { val: unansweredCount, label: "Left" },
      ].map(({ val, label }) => (
        <div key={label} className="rounded-lg border border-slate-200 bg-white py-2">
          <p className="font-mono text-lg font-bold tabular text-slate-900">{val}</p>
          <p className="text-[11px] text-slate-500">{label}</p>
        </div>
      ))}
    </div>
  );

  const statusRows = [
    { label: "Camera",      ok: cameraActive,   okText: "Active",   failText: "Off",       OkIcon: Video,        FailIcon: VideoOff },
    { label: "Face",        ok: faceDetected,   okText: "Detected", failText: "Not found", OkIcon: UserCheck,    FailIcon: UserX },
    { label: "People",      ok: !multipleFaces, okText: "Only you", failText: "Multiple",  OkIcon: UserCheck,    FailIcon: Users },
    { label: "Attention",   ok: !lookingAway,   okText: "Focused",  failText: "Away",      OkIcon: Eye,          FailIcon: AlertTriangle },
    { label: "Eyes",        ok: eyesOpen,       okText: "Open",     failText: "Closed",    OkIcon: Eye,          FailIcon: EyeOff },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex select-none flex-col bg-canvas">

      {/* Warning toast */}
      {showWarning && (
        <div className="fixed left-1/2 top-4 z-[65] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 animate-slide-down" role="alert">
          <div className="flex items-start gap-3 rounded-lg border border-rose-300 bg-white px-4 py-3 shadow-pop">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium text-slate-900">{warningMessage}</p>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="relative z-10 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-5">
        <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white sm:flex">
          <ShieldCheck className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{examTitle}</p>
          <p className="text-xs text-slate-500">Question {currentQuestion + 1} of {questions.length} · {answeredCount} answered</p>
        </div>

        <div className={cn("hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold md:flex", proctorCls)}>
          <ProctorIcon className="h-3.5 w-3.5" aria-hidden="true" />{proctor.label}
        </div>

        <div className="hidden items-center gap-1 sm:flex" title={`${warnings} of ${MAX_WARNINGS} warnings`} aria-label={`${warnings} of ${MAX_WARNINGS} warnings used`}>
          {Array.from({ length: MAX_WARNINGS }).map((_, i) => (
            <span key={i} className={cn("h-2 w-2 rounded-full transition-colors", i < warnings ? "bg-rose-500" : "bg-slate-200")} />
          ))}
          <span className={cn("ml-1 font-mono text-xs font-bold", warnings >= MAX_WARNINGS - 1 ? "text-rose-600" : "text-slate-500")}>{warnings}/{MAX_WARNINGS}</span>
        </div>

        <div role="timer" aria-label="Time remaining" className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5", timerCls)}>
          <Clock className="h-4 w-4" aria-hidden="true" />
          <span className="font-mono text-sm font-bold tabular sm:text-base">{fmt(timeRemaining)}</span>
        </div>

        <Button
          variant="success"
          icon={Send}
          onClick={() => setShowSubmitConfirm(true)}
          disabled={submitting}
          className="hidden sm:inline-flex"
        >
          Submit
        </Button>
      </header>

      {/* Answer progress */}
      <div className="h-1 w-full shrink-0 bg-slate-200" aria-hidden="true">
        <div className="h-full bg-brand-500 transition-[width] duration-300" style={{ width: `${progress}%` }} />
      </div>

      {/* Mobile status strip */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 md:hidden">
        <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold", proctorCls)}>
          <ProctorIcon className="h-3.5 w-3.5" aria-hidden="true" />{proctor.label}
        </span>
        <span className={cn("ml-auto font-mono text-xs font-bold", warnings > 0 ? "text-rose-600" : "text-slate-500")}>
          {warnings}/{MAX_WARNINGS} warnings
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── Question area ── */}
        <main className="min-w-0 flex-1 overflow-y-auto px-3 py-5 pb-28 sm:px-6 lg:pb-8">
          <div className="mx-auto max-w-3xl">
            {hasSections && (
              <div role="tablist" aria-label="Exam sections" className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1.5">
                {sectionGroups.map((g) => {
                  const active = g.name === currentSection;
                  return (
                    <button
                      key={g.name || "other"}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setCurrentQuestion(g.indexes.find((i) => answers[i] === undefined) ?? g.indexes[0])}
                      className={cn(
                        "flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors",
                        active ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                      )}
                    >
                      {g.name || "Other"}
                      <span className={cn("rounded-full px-2 py-0.5 font-mono text-[11px] tabular", active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600")}>
                        {g.answered}/{g.indexes.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <article className="card p-5 sm:p-7" aria-labelledby="question-text">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-slate-900 px-2.5 py-1 font-mono text-xs font-bold text-white">Q{currentQuestion + 1}</span>
                  {currentSection && <span className="rounded-md bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700">{currentSection}</span>}
                  <span className="text-xs font-medium text-slate-500">{marksPerQ} mark{marksPerQ > 1 ? "s" : ""}</span>
                </div>
                <button
                  type="button"
                  onClick={toggleMark}
                  aria-pressed={isMarked}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors",
                    isMarked ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  )}
                >
                  <Flag className={cn("h-3.5 w-3.5", isMarked && "fill-amber-500 text-amber-600")} aria-hidden="true" />
                  {isMarked ? "Marked for review" : "Mark for review"}
                </button>
              </div>

              <h2 id="question-text" className="whitespace-pre-line text-base font-semibold leading-relaxed text-slate-900 sm:text-lg">
                {currentQ?.text || currentQ?.question}
              </h2>

              <div role="radiogroup" aria-labelledby="question-text" className="mt-6 space-y-2.5">
                {(currentQ?.options || []).map((opt, i) => {
                  const sel = answers[currentQuestion] === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      onClick={() => selectOption(i)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border-2 px-4 py-3.5 text-left transition-colors",
                        sel ? "border-brand-600 bg-brand-50" : "border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/40"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                          sel ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"
                        )}
                        aria-hidden="true"
                      >
                        {String.fromCharCode(65 + i)}
                      </span>
                      <span className={cn("flex-1 text-sm sm:text-[15px]", sel ? "font-medium text-slate-900" : "text-slate-700")}>{opt}</span>
                      {sel && <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>

              {/* Desktop prev / next */}
              <div className="mt-8 hidden items-center justify-between border-t border-slate-100 pt-5 lg:flex">
                <Button variant="secondary" icon={ChevronLeft} onClick={() => setCurrentQuestion((p) => p - 1)} disabled={currentQuestion === 0}>
                  Previous
                </Button>
                <span className="font-mono text-xs text-slate-500">{currentQuestion + 1} / {questions.length}</span>
                {currentQuestion === questions.length - 1 ? (
                  <Button variant="success" icon={Send} onClick={() => setShowSubmitConfirm(true)} disabled={submitting}>Review & submit</Button>
                ) : (
                  <Button iconRight={ChevronRight} onClick={() => setCurrentQuestion((p) => p + 1)}>Next</Button>
                )}
              </div>
            </article>
          </div>
        </main>

        {/* ── Side panel (desktop) / camera dock (mobile) — videoRef re-attached via effect ── */}
        <aside
          className={cn(
            "z-20 flex flex-col",
            "fixed bottom-20 right-3 w-28 sm:w-36",
            "lg:static lg:w-80 lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-slate-200 lg:bg-white"
          )}
          aria-label="Proctoring and navigation"
        >
          <div className="lg:space-y-5 lg:p-4">
            {cameraEnabled ? (
              <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-300 bg-slate-900 shadow-pop lg:rounded-xl lg:border-slate-200 lg:shadow-none">
                <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
                <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100" />
                <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white lg:left-2 lg:top-2 lg:px-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", cameraActive ? "animate-pulse bg-rose-500" : "bg-slate-400")} /> LIVE
                </span>
                {!cameraActive && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-slate-900/85 px-2 text-center">
                    <CameraOff className="h-5 w-5 text-slate-300" aria-hidden="true" />
                    <span className="hidden text-xs text-slate-300 lg:block">{cameraError || "Camera unavailable"}</span>
                  </div>
                )}
                <span className="absolute bottom-2 right-2 hidden rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white lg:block">
                  {modelStatus === "loading" ? "Loading AI…" : modelStatus === "ready" ? "AI active" : "Motion mode"}
                </span>
              </div>
            ) : (
              <div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600 lg:flex">
                <VideoOff className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" /> Camera proctoring is off for this exam
              </div>
            )}

            <div className="hidden space-y-5 lg:block">
              {/* Proctoring status */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Proctoring</h3>
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {cameraEnabled && statusRows.map(({ label, ok, okText, failText, OkIcon, FailIcon }) => (
                    <li key={label} className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="text-slate-600">{label}</span>
                      <span className={cn("flex items-center gap-1 font-semibold", ok ? "text-emerald-700" : "text-rose-600")}>
                        {ok ? <OkIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <FailIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                        {ok ? okText : failText}
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-slate-600">Fullscreen</span>
                    <span className={cn("flex items-center gap-1 font-semibold", isFullscreen ? "text-emerald-700" : "text-rose-600")}>
                      <Maximize className="h-3.5 w-3.5" aria-hidden="true" />{isFullscreen ? "On" : "Exited"}
                    </span>
                  </li>
                </ul>
              </section>

              {warnings > 0 && (
                <div className={cn(
                  "rounded-lg border px-3 py-2.5",
                  warnings >= MAX_WARNINGS - 1 ? "border-rose-300 bg-rose-50" : "border-amber-200 bg-amber-50"
                )}>
                  <p className={cn("flex items-center gap-1.5 text-sm font-semibold", warnings >= MAX_WARNINGS - 1 ? "text-rose-700" : "text-amber-900")}>
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Warning {warnings} of {MAX_WARNINGS}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {MAX_WARNINGS - warnings} more and the exam submits automatically.
                  </p>
                </div>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Questions</h3>
                {questionGrid}
              </section>

              {counts}

              <Button variant="success" icon={Send} size="lg" fullWidth onClick={() => setShowSubmitConfirm(true)} disabled={submitting}>
                Submit exam
              </Button>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Mobile bottom bar ── */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-2.5 lg:hidden" aria-label="Question navigation">
        <Button variant="secondary" icon={ChevronLeft} onClick={() => setCurrentQuestion((p) => p - 1)} disabled={currentQuestion === 0} aria-label="Previous question">
          <span className="hidden sm:inline">Prev</span>
        </Button>
        <Button variant="secondary" icon={LayoutGrid} onClick={() => setShowPalette(true)} className="flex-1">
          {currentQuestion + 1} / {questions.length}
        </Button>
        {currentQuestion === questions.length - 1 ? (
          <Button variant="success" icon={Send} onClick={() => setShowSubmitConfirm(true)} disabled={submitting}>Submit</Button>
        ) : (
          <Button iconRight={ChevronRight} onClick={() => setCurrentQuestion((p) => p + 1)} aria-label="Next question">
            <span className="hidden sm:inline">Next</span>
          </Button>
        )}
      </nav>

      {/* ── Mobile question palette ── */}
      {showPalette && (
        <div className="fixed inset-0 z-[66] lg:hidden" role="dialog" aria-modal="true" aria-label="All questions">
          <div className="absolute inset-0 animate-fade-in bg-slate-900/40" onClick={() => setShowPalette(false)} aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] animate-scale-in overflow-y-auto rounded-t-2xl bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">All questions</h2>
              <button type="button" onClick={() => setShowPalette(false)} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            {questionGrid}
            <div className="mt-5">{counts}</div>
            <Button variant="success" icon={Send} fullWidth size="lg" className="mt-5" onClick={() => { setShowPalette(false); setShowSubmitConfirm(true); }} disabled={submitting}>
              Submit exam
            </Button>
          </div>
        </div>
      )}

      {/* ── Submit confirmation ── */}
      {showSubmitConfirm && (
        <Modal
          onClose={() => setShowSubmitConfirm(false)}
          dismissible={!submitting}
          size="sm"
          icon={Send}
          title="Submit your exam?"
          description={unansweredCount > 0
            ? `${unansweredCount} question${unansweredCount !== 1 ? "s are" : " is"} still unanswered.`
            : "All questions are answered."}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowSubmitConfirm(false)} disabled={submitting} data-autofocus>Keep working</Button>
              <Button variant="success" loading={submitting} onClick={() => { setShowSubmitConfirm(false); submitExam(false); }}>
                {submitting ? "Submitting…" : "Submit exam"}
              </Button>
            </>
          }
        >
          <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {[
              { label: "Answered",          val: answeredCount,   cls: "text-emerald-700" },
              { label: "Marked for review", val: markedCount,     cls: "text-amber-700" },
              { label: "Unanswered",        val: unansweredCount, cls: "text-rose-600" },
            ].map(({ label, val, cls }) => (
              <div key={label} className="flex justify-between px-3 py-2">
                <dt className="text-slate-600">{label}</dt>
                <dd className={cn("font-mono font-bold", cls)}>{val}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500">You can't change your answers after submitting.</p>
        </Modal>
      )}

      {/* Submitting overlay (manual or automatic) */}
      {submitting && (
        <div className="fixed inset-0 z-[67] flex items-center justify-center bg-white/80 backdrop-blur-sm" role="status">
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-pop">
            <Loader2 className="h-5 w-5 animate-spin text-brand-600" aria-hidden="true" />
            <span className="text-sm font-medium text-slate-800">Submitting your answers…</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamInterface;
