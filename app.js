/* ============================================================
   PAST PAPER TRACKER — standalone vanilla JS app
   Backend: Firebase Firestore (single shared document)
   No build step, no framework — plain DOM rendering
   ============================================================ */

/* ---------------- DATA MODEL ---------------- */

const SUBJECTS = {
  olevel: { label: "O Level", papers: [2, 4, 6] },
  as: { label: "AS Level", papers: [1, 2] },
  a2: { label: "A2 Level", papers: [4] },
  alevel: { label: "Full A Level (AS+A2)", papers: [1, 2, 4] },
  combined: { label: "Combined Science", papers: [2, 4, 6] },
};

const SESSIONS = [
  { key: "mar", label: "March", variants: [2] },
  { key: "jun", label: "May/June", variants: [1, 2, 3] },
  { key: "nov", label: "Oct/Nov", variants: [1, 2, 3] },
];
const sessionByKey = (k) => SESSIONS.find((s) => s.key === k);

const examKey = (subject, paper, year, session, variant) =>
  `${subject}-${paper}-${year}-${session}-${variant}`;

const examLabel = (subject, paper, year, session, variant) => {
  const sLabel = sessionByKey(session)?.label ?? session;
  return `${SUBJECTS[subject]?.label ?? subject} • Paper ${paper}${variant} • ${sLabel} ${year}`;
};

const DEFAULT_TOTALS = {
  olevel: { 2: 40, 4: 80, 6: 40 },
  as: { 1: 40, 2: 60 },
  a2: { 4: 100 },
  alevel: { 1: 40, 2: 60, 4: 100 },
  combined: {},
};
const LOCK_CUTOFF_YEAR = 2023; // exams from this year onward use fixed, uneditable totals

function getDefaultTotal(subject, paper) {
  return DEFAULT_TOTALS[subject]?.[paper] ?? null;
}

// Resolves whether a given exam's total is locked, and to what value.
// Returns { locked: bool, total: number|null, source: "builtin"|"manual"|null }
function resolveExamTotal(subject, paper, year, ek) {
  if (year >= LOCK_CUTOFF_YEAR) {
    const builtin = getDefaultTotal(subject, paper);
    return { locked: true, total: builtin, source: "builtin" };
  }
  // pre-cutoff: locked only if teacher has manually locked this specific exam
  const manualLock = STATE.lockedTotals?.[ek];
  if (manualLock != null) {
    return { locked: true, total: manualLock, source: "manual" };
  }
  return { locked: false, total: STATE.examTotals?.[ek] ?? null, source: null };
}

const DEFAULT_TEACHER_PASSCODE = "teach2027";

const uid = () => Math.random().toString(36).slice(2, 10);

function daysSince(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------------- STATE ---------------- */
// One in-memory store, persisted to Firestore as a single document.
// Shape:
// {
//   students: [{ id, name, subject, classIds: [], passcode: null }],
//   classes: [{ id, name }],
//   submissions: [...],
//   examTotals: { examKey: total },
//   resolvedQuestions: { "examKey::norm": true },
//   teacherPasscode: "..."
// }

const DEFAULT_STATE = {
  students: [],
  classes: [],
  submissions: [],
  examTotals: {},
  lockedTotals: {}, // { examKey: totalMarks } — pre-2023 exams manually locked by teacher
  resolvedQuestions: {},
  teacherPasscode: DEFAULT_TEACHER_PASSCODE,
  todaysPlan: {}, // { classId: [ { id, subject, paper, year, session, variant, examKey, examLabel } ] }
};

let STATE = null; // populated once Firestore loads
let unsubscribe = null;

async function initStore() {
  await new Promise((resolve) => {
    if (window.__firebaseReady) resolve();
    else window.addEventListener("firebase-ready", () => resolve(), { once: true });
  });

  const { getDoc, setDoc, onSnapshot, DOC_REF } = window.__firestore;

  const snap = await getDoc(DOC_REF);
  if (!snap.exists()) {
    await setDoc(DOC_REF, DEFAULT_STATE);
    STATE = { ...DEFAULT_STATE };
  } else {
    STATE = { ...DEFAULT_STATE, ...snap.data() };
  }

  // live sync: any change from any device updates STATE and re-renders
  unsubscribe = onSnapshot(DOC_REF, (snap2) => {
    if (snap2.exists()) {
      STATE = { ...DEFAULT_STATE, ...snap2.data() };
      render();
    }
  });
}

async function saveState(partial) {
  STATE = { ...STATE, ...partial };
  const { setDoc, DOC_REF } = window.__firestore;
  await setDoc(DOC_REF, STATE, { merge: true });
  render();
}

/* ---------------- ROUTING / APP STATE ---------------- */

let VIEW = { mode: null, teacherAuthed: false };
// student session state
let STUDENT_SESSION = { studentId: null, step: "pick-student" };
// teacher session state
let TEACHER_SESSION = { tab: "overview" };

const root = () => document.getElementById("root");

function setView(next) {
  VIEW = { ...VIEW, ...next };
  render();
}

function render() {
  const loadingEl = document.getElementById("loading-screen");
  if (!STATE) {
    if (loadingEl) loadingEl.style.display = "flex";
    return;
  }
  if (loadingEl) loadingEl.style.display = "none";

  let html = "";
  if (!VIEW.mode) {
    html = renderGate();
  } else if (VIEW.mode === "student") {
    html = renderStudentApp();
  } else if (VIEW.mode === "teacher" && !VIEW.teacherAuthed) {
    html = renderTeacherGate();
  } else if (VIEW.mode === "teacher" && VIEW.teacherAuthed) {
    html = renderTeacherApp();
  }
  root().innerHTML = html;
  attachHandlers();
}

/* ---------------- GATE (LANDING) ---------------- */

function renderGate() {
  return `
    <div style="min-height:640px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 24px;text-align:center;">
      <div style="margin-bottom:56px;">
        <div style="font-size:22px;font-weight:500;letter-spacing:0.01em;margin-bottom:10px;">
          Dr. Mohamed El-Mekawy
        </div>
        <div style="width:56px;height:2px;background:var(--accent);margin:0 auto;"></div>
      </div>
      <div style="font-size:30px;font-weight:500;letter-spacing:0.02em;color:var(--ink);margin-bottom:44px;">
        Past Paper Tracker
      </div>
      <div style="display:flex;gap:12px;">
        <button class="btn btn-primary" style="padding:14px 30px;" data-action="goto-student">I'm a Student</button>
        <button class="btn btn-ghost" style="padding:14px 30px;" data-action="goto-teacher">Teacher Dashboard</button>
      </div>
    </div>
  `;
}

function topBar(title, onExitAction) {
  return `
    <div class="ui" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <button data-action="${onExitAction}" style="background:none;border:none;color:var(--ink-soft);font-size:14px;cursor:pointer;padding:0;">← Home</button>
      <div style="font-size:13px;font-weight:700;color:var(--ink-soft);">${escapeHtml(title)}</div>
    </div>
  `;
}

function emptyState(text) {
  return `<div class="ui" style="text-align:center;padding:30px 10px;color:var(--ink-soft);font-size:14px;">${escapeHtml(text)}</div>`;
}

function label(text) {
  return `<div class="label">${escapeHtml(text)}</div>`;
}

/* ---------------- DIGIT PAD (shared by teacher passcode + student code) ---------------- */

function digitDots(value, length = 4) {
  let dots = "";
  for (let i = 0; i < length; i++) {
    const filled = i < value.length;
    dots += `<div style="width:16px;height:16px;border-radius:50%;border:1.5px solid var(--ink);background:${filled ? "var(--ink)" : "transparent"};"></div>`;
  }
  return `<div style="display:flex;gap:14px;justify-content:center;margin:20px 0;">${dots}</div>`;
}

function keypad(onDigitAction, onDeleteAction, disabled) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
  const cells = keys
    .map((k) => {
      if (k === "") return `<div></div>`;
      if (k === "del") {
        return `<button class="key" data-action="${onDeleteAction}" ${disabled ? "disabled" : ""}>⌫</button>`;
      }
      return `<button class="key" data-action="${onDigitAction}" data-digit="${k}" ${disabled ? "disabled" : ""}>${k}</button>`;
    })
    .join("");
  return `<div class="keypad">${cells}</div>`;
}

/* ---------------- TEACHER PASSCODE GATE ---------------- */

let teacherGateState = { code: "", error: "" };

function renderTeacherGate() {
  const { code, error } = teacherGateState;
  return `
    <div style="min-height:480px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 24px;">
      <div class="card" style="max-width:340px;width:100%;">
        ${label("Teacher passcode")}
        <input id="teacher-passcode-input" type="password" placeholder="Enter passcode" value="${escapeHtml(code)}" autocomplete="off" />
        ${error ? `<div class="ui" style="color:var(--danger);font-size:13px;margin-top:8px;">${escapeHtml(error)}</div>` : ""}
        <div style="display:flex;gap:10px;margin-top:18px;">
          <button class="btn btn-ghost" data-action="exit-to-gate">Back</button>
          <button class="btn btn-primary" style="flex:1;" data-action="teacher-passcode-submit">Enter</button>
        </div>
      </div>
    </div>
  `;
}

function teacherPasscodeSubmit() {
  const input = document.getElementById("teacher-passcode-input");
  const val = input ? input.value : "";
  if (val === (STATE.teacherPasscode || DEFAULT_TEACHER_PASSCODE)) {
    teacherGateState = { code: "", error: "" };
    setView({ teacherAuthed: true });
  } else {
    teacherGateState = { code: val, error: "Incorrect passcode." };
    render();
  }
}

/* ---------------- STUDENT APP ---------------- */

function renderStudentApp() {
  const { studentId, step } = STUDENT_SESSION;
  const student = STATE.students.find((s) => s.id === studentId);
  const title = student ? student.name : "Submit a result";

  let body = "";
  if (step === "pick-student") body = renderPickStudent();
  else if (step === "set-code" && student) body = renderSetCode(student);
  else if (step === "enter-code" && student) body = renderEnterCode(student);
  else if (step === "menu" && student) body = renderStudentMenu(student);
  else if (step === "progress" && student) body = renderMyProgress(student);
  else if (step === "form" && student) body = renderSubmitForm(student);
  else if (step === "done" && student) body = renderDone(student);
  else body = renderPickStudent();

  return `
    <div style="max-width:560px;margin:0 auto;padding:28px 20px 60px;">
      ${topBar(title, "exit-to-gate")}
      ${body}
    </div>
  `;
}

function renderPickStudent() {
  const q = (STUDENT_SESSION.searchQuery || "").toLowerCase();
  const filtered = STATE.students.filter((s) => s.name.toLowerCase().includes(q));
  const list = filtered
    .map(
      (s) => `
      <button class="ui" data-action="pick-student" data-id="${s.id}" style="text-align:left;padding:13px 16px;border-radius:10px;border:1px solid var(--line);background:var(--surface);cursor:pointer;display:flex;justify-content:space-between;align-items:center;width:100%;">
        <span style="font-weight:600;">${escapeHtml(s.name)}</span>
        <span style="font-size:12px;color:var(--ink-soft);">${escapeHtml(SUBJECTS[s.subject]?.label || "")}</span>
      </button>
    `
    )
    .join("");

  return `
    <div class="card">
      <div class="field">
        ${label("Find your name")}
        <input id="student-search" class="ui" placeholder="Start typing…" value="${escapeHtml(STUDENT_SESSION.searchQuery || "")}" autofocus />
      </div>
      ${STATE.students.length === 0 ? `<p class="ui" style="color:var(--ink-soft);font-size:14px;">No students yet — ask your teacher to add you in the Teacher Dashboard.</p>` : ""}
      <div style="display:flex;flex-direction:column;gap:8px;max-height:360px;overflow-y:auto;">
        ${list}
      </div>
    </div>
  `;
}

function renderSetCode(student) {
  const { code, confirmStage, error } = STUDENT_SESSION.setCode || { code: "", confirmStage: false, error: "" };
  return `
    <div class="card" style="text-align:center;">
      <h3 style="margin:0 0 6px;">Set a 4-digit code, ${escapeHtml(student.name.split(" ")[0])}</h3>
      <p class="ui" style="color:var(--ink-soft);font-size:14px;">
        ${confirmStage ? "Enter it again to confirm." : "You'll use this to access your results next time."}
      </p>
      ${digitDots(code)}
      ${error ? `<div class="ui" style="color:var(--danger);font-size:13px;margin-bottom:10px;">${escapeHtml(error)}</div>` : ""}
      ${keypad("setcode-digit", "setcode-delete")}
      <div style="margin-top:22px;">
        <button class="btn btn-ghost" data-action="exit-to-pick-student">Back</button>
      </div>
    </div>
  `;
}

function renderEnterCode(student) {
  const { code, error, attempts } = STUDENT_SESSION.enterCode || { code: "", error: "", attempts: 0 };
  const lockedOut = attempts >= 2;
  return `
    <div class="card" style="text-align:center;">
      <h3 style="margin:0 0 6px;">Hi, ${escapeHtml(student.name.split(" ")[0])}</h3>
      <p class="ui" style="color:var(--ink-soft);font-size:14px;">
        ${lockedOut ? "Locked — see your teacher to reset your code." : "Enter your code"}
      </p>
      ${digitDots(code)}
      ${error ? `<div class="ui" style="color:var(--danger);font-size:13px;margin-bottom:10px;">${escapeHtml(error)}</div>` : ""}
      ${lockedOut ? "" : keypad("entercode-digit", "entercode-delete")}
      <div style="margin-top:22px;">
        <button class="btn btn-ghost" data-action="exit-to-pick-student">Not you? Switch student</button>
      </div>
    </div>
  `;
}

function getStudentTodaysExams(student) {
  const classIds = student.classIds || [];
  const seen = new Set();
  const exams = [];
  for (const cid of classIds) {
    for (const ex of STATE.todaysPlan[cid] || []) {
      if (!seen.has(ex.examKey)) {
        seen.add(ex.examKey);
        exams.push(ex);
      }
    }
  }
  return exams;
}

function renderStudentMenu(student) {
  const todaysExams = getStudentTodaysExams(student);
  const doneCount = todaysExams.filter((ex) => hasSubmittedExam(student.id, ex)).length;
  const nextExam = todaysExams.find((ex) => !hasSubmittedExam(student.id, ex));

  let planBanner = "";
  if (todaysExams.length > 0) {
    const rows = todaysExams
      .map((ex) => {
        const done = hasSubmittedExam(student.id, ex);
        return `
        <div class="today-exam-row">
          <span class="check ${done ? "done" : ""}">${done ? "✓" : "○"}</span>
          <span class="today-exam-text ${done ? "done-text" : ""}">${escapeHtml(ex.examLabel)}</span>
        </div>`;
      })
      .join("");
    planBanner = `
      <div class="assigned-banner">
        <div class="assigned-label">Assigned for today · ${doneCount} of ${todaysExams.length} done</div>
        ${rows}
      </div>
    `;
  }

  let mainAction;
  if (nextExam) {
    mainAction = `
      <button class="btn btn-primary" data-action="goto-form-prefilled" data-examkey="${nextExam.examKey}" style="text-align:left;display:flex;justify-content:space-between;align-items:center;">
        <span>Submit next exam</span>
        <span class="ui" style="font-size:12px;opacity:0.85;">→</span>
      </button>`;
  } else if (todaysExams.length > 0) {
    mainAction = `
      <div class="ui" style="background:var(--accent-tint);border-radius:10px;padding:14px;text-align:center;font-size:14px;font-weight:600;color:var(--accent);">
        All of today's exams submitted ✓
      </div>`;
  } else {
    mainAction = `<button class="btn btn-primary" data-action="goto-form">Submit a result</button>`;
  }

  return `
    ${planBanner}
    <div class="card">
      <h3 style="margin:0 0 6px;">Hi, ${escapeHtml(student.name.split(" ")[0])}.</h3>
      <p class="ui" style="color:var(--ink-soft);font-size:14px;margin-bottom:22px;">What would you like to do?</p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${mainAction}
        ${todaysExams.length > 0 ? `<button class="btn btn-quiet" data-action="goto-form">Submit a different exam</button>` : ""}
        <button class="btn btn-quiet" data-action="goto-progress">View my progress</button>
        <button class="btn btn-ghost" data-action="exit-to-pick-student">Switch student</button>
      </div>
    </div>
  `;
}

function renderDone(student) {
  return `
    <div class="card" style="text-align:center;padding:40px;">
      <div style="font-size:40px;margin-bottom:10px;">✓</div>
      <h2 style="margin:0 0 8px;">Logged.</h2>
      <p class="ui" style="color:var(--ink-soft);margin-bottom:24px;">Nice work, ${escapeHtml(student.name.split(" ")[0])}.</p>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button class="btn btn-quiet" data-action="goto-form">Submit another</button>
        <button class="btn btn-ghost" data-action="goto-menu">Back to menu</button>
      </div>
    </div>
  `;
}

/* ---------------- TREND CHART (SVG sparkline) ---------------- */

function trendChartSvg(submissionsNewestFirst) {
  const points = [...submissionsNewestFirst].reverse().map((s) => Math.round((s.score / s.total) * 100));
  const w = 100, h = 36, pad = 4, max = 100, min = 0;
  const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p - min) / (max - min)) * (h - pad * 2);
    return [x, y];
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = points[0], last = points[points.length - 1];
  const trendColor = last >= first ? "var(--good)" : "var(--danger)";
  const circles = coords.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${trendColor}" />`).join("");
  return `
    <div style="display:flex;align-items:center;gap:12px;">
      <svg viewBox="0 0 ${w} ${h}" width="160" height="${h * 1.6}" preserveAspectRatio="none">
        <path d="${path}" fill="none" stroke="${trendColor}" stroke-width="2" vector-effect="non-scaling-stroke" />
        ${circles}
      </svg>
      <span class="ui" style="font-size:13px;color:var(--ink-soft);">${first}% → ${last}%</span>
    </div>
  `;
}

function statBlock(lbl, value) {
  return `
    <div>
      <div class="ui" style="font-size:11px;font-weight:700;color:var(--ink-soft);text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(lbl)}</div>
      <div style="font-size:24px;font-weight:700;">${escapeHtml(String(value))}</div>
    </div>
  `;
}

/* ---------------- MY PROGRESS (student, private) ---------------- */

function renderMyProgress(student) {
  const subs = STATE.submissions
    .filter((s) => s.studentId === student.id)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  const avgPct = subs.length ? Math.round((subs.reduce((acc, s) => acc + s.score / s.total, 0) / subs.length) * 100) : null;
  const avgTime = subs.length ? Math.round(subs.reduce((acc, s) => acc + s.minutes, 0) / subs.length) : null;

  const historyItems = subs
    .map(
      (s) => `
      <div style="border-bottom:1px solid var(--line);padding-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <div style="font-weight:700;font-size:15px;">${escapeHtml(s.examLabel)}</div>
          <div class="ui" style="font-size:13px;color:var(--ink-soft);">${new Date(s.submittedAt).toLocaleDateString()}</div>
        </div>
        <div class="ui" style="font-size:13px;color:var(--ink-soft);margin-top:4px;">
          ${s.score}/${s.total} (${Math.round((s.score / s.total) * 100)}%) · ${s.minutes} min
          ${s.difficultQuestions?.length ? ` · flagged Q${s.difficultQuestions.join(", Q")}` : ""}
        </div>
      </div>
    `
    )
    .join("");

  return `
    <div>
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;gap:24px;flex-wrap:wrap;">
          ${statBlock("Exams logged", subs.length)}
          ${statBlock("Avg score", avgPct != null ? avgPct + "%" : "—")}
          ${statBlock("Avg time", avgTime != null ? avgTime + " min" : "—")}
        </div>
      </div>
      <div class="card">
        <h4 style="margin:0 0 14px;font-size:14px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-soft);">History</h4>
        ${subs.length === 0 ? emptyState("No submissions yet — log your first result to see it here.") : `<div style="display:flex;flex-direction:column;gap:12px;">${historyItems}</div>`}
      </div>
      <div style="margin-top:16px;">
        <button class="btn btn-ghost" data-action="goto-menu">Back</button>
      </div>
    </div>
  `;
}

/* ---------------- SUBMIT FORM ---------------- */

function getFormState() {
  if (!STUDENT_SESSION.form) {
    STUDENT_SESSION.form = {
      paper: null, year: null, session: null, variant: null,
      score: "", totalInput: "", editTotal: false,
      minutes: "", difficultRaw: "", error: "",
    };
  }
  return STUDENT_SESSION.form;
}

function renderSubmitForm(student) {
  const f = getFormState();
  const subjectDef = SUBJECTS[student.subject];
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 8; y--) years.push(y);

  const paperChips = subjectDef.papers
    .map((p) => `<button class="chip ${f.paper === p ? "active" : ""}" data-action="form-set-paper" data-value="${p}">Paper ${p}</button>`)
    .join("");
  const yearChips = years
    .map((y) => `<button class="chip ${f.year === y ? "active" : ""}" data-action="form-set-year" data-value="${y}">${y}</button>`)
    .join("");
  const sessionChips = SESSIONS.map(
    (s) => `<button class="chip ${f.session === s.key ? "active" : ""}" data-action="form-set-session" data-value="${s.key}">${s.label}</button>`
  ).join("");

  let variantBlock = "";
  if (f.session === "mar" && f.paper) {
    variantBlock = `
      <div class="field">
        ${label("Variant")}
        <div class="ui" style="font-size:14px;color:var(--ink-soft);">March only runs variant 2 — Paper ${f.paper}2 selected automatically.</div>
      </div>
    `;
  } else if (f.session && f.session !== "mar") {
    const variants = sessionByKey(f.session).variants;
    const vChips = variants
      .map((v) => `<button class="chip ${f.variant === v ? "active" : ""}" data-action="form-set-variant" data-value="${v}">${f.paper ? `${f.paper}${v}` : v}</button>`)
      .join("");
    variantBlock = `<div class="field">${label("Variant")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${vChips}</div></div>`;
  }

  const ek = f.paper && f.year && f.session && f.variant ? examKey(student.subject, f.paper, f.year, f.session, f.variant) : null;
  const resolved = ek != null ? resolveExamTotal(student.subject, f.paper, f.year, ek) : { locked: false, total: null, source: null };
  const defaultTotal = resolved.total;

  if (ek && !f.editTotal && f.totalInput === "") {
    f.totalInput = defaultTotal != null ? String(defaultTotal) : "";
  }
  // if locked, always force the field to the locked value regardless of any stale local edit
  if (ek && resolved.locked && defaultTotal != null) {
    f.totalInput = String(defaultTotal);
  }

  let detailsBlock = "";
  if (ek) {
    let totalHelp;
    if (resolved.locked && resolved.source === "builtin") {
      totalHelp = `Total marks are fixed at ${defaultTotal} for this paper.`;
    } else if (resolved.locked && resolved.source === "manual") {
      totalHelp = `Total marks are locked at ${defaultTotal} based on past submissions for this exam.`;
    } else if (defaultTotal != null) {
      totalHelp = `Total defaults to ${defaultTotal}. Change it if questions were cancelled on this paper.`;
    } else {
      totalHelp = "No default for this paper — enter the total marks for this exam.";
    }
    detailsBlock = `
      <div class="ui" style="background:var(--surface-2);border-radius:10px;padding:10px 14px;font-size:13px;color:var(--ink-soft);margin-bottom:22px;">
        Logging: <strong style="color:var(--ink);">${escapeHtml(examLabel(student.subject, f.paper, f.year, f.session, f.variant))}</strong>
      </div>
      <div class="field">
        ${label("Score & total")}
        <div style="display:flex;gap:10px;align-items:center;">
          <input id="form-score" type="number" placeholder="Your mark" value="${escapeHtml(f.score)}" style="flex:1;" />
          <span class="ui" style="color:var(--ink-soft);">/</span>
          <input id="form-total" type="number" placeholder="Total" value="${escapeHtml(f.totalInput)}" style="flex:1;" ${resolved.locked ? "disabled" : ""} />
        </div>
        <div class="ui" style="font-size:12px;color:var(--ink-soft);margin-top:6px;">
          ${totalHelp}
        </div>
      </div>
      <div class="field">
        ${label("Time taken (minutes)")}
        <input id="form-minutes" type="number" placeholder="e.g. 75" value="${escapeHtml(f.minutes)}" />
      </div>
      <div class="field">
        ${label("Questions you need help with")}
        <textarea id="form-difficult" rows="3" placeholder="e.g. 1aii, 1b, 2c, 4bii, 4cii, 5a, 6">${escapeHtml(f.difficultRaw)}</textarea>
        <div class="ui" style="font-size:12px;color:var(--ink-soft);margin-top:6px;">Separate with commas. Leave blank if there's nothing you're stuck on.</div>
      </div>
    `;
  }

  return `
    <div class="card">
      <div class="field">${label("Paper")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${paperChips}</div></div>
      <div class="field">${label("Year")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${yearChips}</div></div>
      <div class="field">${label("Session")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${sessionChips}</div></div>
      ${variantBlock}
      ${detailsBlock}
      ${f.error ? `<div class="ui" style="color:var(--danger);font-size:13px;margin-bottom:16px;">${escapeHtml(f.error)}</div>` : ""}
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn btn-ghost" data-action="goto-menu">Back</button>
        <button class="btn btn-primary" style="flex:1;" data-action="form-submit" ${!ek || f.score === "" || f.totalInput === "" || f.minutes === "" ? "disabled" : ""}>Submit result</button>
      </div>
    </div>
  `;
}

/* ---------------- TEACHER APP SHELL ---------------- */

function renderTeacherApp() {
  const tabs = [
    ["overview", "Overview"],
    ["plan", "Today's Plan"],
    ["questions", "Difficult Questions"],
    ["students", "Student Progress"],
    ["roster", "Manage Roster"],
    ["classes", "Manage Classes"],
    ["totals", "Lock Totals"],
    ["log", "All Submissions"],
    ["settings", "Settings"],
  ];
  const tabBtns = tabs
    .map(
      ([key, lbl]) =>
        `<button class="tab-btn ${TEACHER_SESSION.tab === key ? "active" : ""}" data-action="teacher-tab" data-value="${key}">${lbl}</button>`
    )
    .join("");

  let body = "";
  if (TEACHER_SESSION.tab === "overview") body = renderOverviewTab();
  else if (TEACHER_SESSION.tab === "plan") body = renderPlanTab();
  else if (TEACHER_SESSION.tab === "questions") body = renderQuestionsTab();
  else if (TEACHER_SESSION.tab === "students") body = renderStudentsTab();
  else if (TEACHER_SESSION.tab === "roster") body = renderRosterTab();
  else if (TEACHER_SESSION.tab === "classes") body = renderClassesTab();
  else if (TEACHER_SESSION.tab === "totals") body = renderLockTotalsTab();
  else if (TEACHER_SESSION.tab === "log") body = renderLogTab();
  else if (TEACHER_SESSION.tab === "settings") body = renderSettingsTab();

  return `
    <div style="max-width:960px;margin:0 auto;padding:28px 20px 70px;">
      ${topBar("Teacher Dashboard", "exit-to-gate")}
      <div class="ui" style="display:flex;gap:8px;margin-bottom:26px;flex-wrap:wrap;">${tabBtns}</div>
      ${body}
    </div>
  `;
}

/* ---------------- TODAY'S PLAN TAB ---------------- */

let planTabState = {
  selectedClassId: null,
  formSubject: "olevel", formPaper: null, formYear: null, formSession: "jun", formVariant: 1,
};

function ensurePlanFormValid() {
  const now = new Date().getFullYear();
  if (planTabState.formYear == null) planTabState.formYear = now;
  const subjectDef = SUBJECTS[planTabState.formSubject];
  if (!subjectDef.papers.includes(planTabState.formPaper)) {
    planTabState.formPaper = subjectDef.papers[0];
  }
}

function renderPlanTab() {
  if (STATE.classes.length === 0) {
    return `<div class="card">${emptyState("Create a class first under Manage Classes, then come back here to plan exams for it.")}</div>`;
  }
  if (!planTabState.selectedClassId) planTabState.selectedClassId = STATE.classes[0].id;
  ensurePlanFormValid();

  const cls = STATE.classes.find((c) => c.id === planTabState.selectedClassId);
  const classStudents = STATE.students.filter((s) => (s.classIds || []).includes(cls.id));
  const list = STATE.todaysPlan[cls.id] || [];
  const subjectDef = SUBJECTS[planTabState.formSubject];

  const classChips = STATE.classes
    .map((c) => `<button class="chip ${planTabState.selectedClassId === c.id ? "active" : ""}" data-action="plan-select-class" data-value="${c.id}">${escapeHtml(c.name)}</button>`)
    .join("");

  const subjectChips = Object.entries(SUBJECTS)
    .map(([key, def]) => `<button class="chip ${planTabState.formSubject === key ? "active" : ""}" data-action="plan-set-subject" data-value="${key}">${def.label}</button>`)
    .join("");

  const paperChips = subjectDef.papers
    .map((p) => `<button class="chip ${planTabState.formPaper === p ? "active" : ""}" data-action="plan-set-paper" data-value="${p}">Paper ${p}</button>`)
    .join("");

  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 8; y--) years.push(y);
  const yearChips = years
    .map((y) => `<button class="chip ${planTabState.formYear === y ? "active" : ""}" data-action="plan-set-year" data-value="${y}">${y}</button>`)
    .join("");

  const sessionChips = SESSIONS.map(
    (s) => `<button class="chip ${planTabState.formSession === s.key ? "active" : ""}" data-action="plan-set-session" data-value="${s.key}">${s.label}</button>`
  ).join("");

  let variantBlock = "";
  if (planTabState.formSession === "mar") {
    variantBlock = `<div class="note" style="margin-top:10px;">March only runs variant 2 — Paper ${planTabState.formPaper}2 will be added automatically.</div>`;
  } else {
    const variants = sessionByKey(planTabState.formSession).variants;
    const variantChips = variants
      .map((v) => `<button class="chip ${planTabState.formVariant === v ? "active" : ""}" data-action="plan-set-variant" data-value="${v}">${planTabState.formPaper}${v}</button>`)
      .join("");
    variantBlock = `<div class="field" style="margin-top:16px;margin-bottom:0;">${label("Variant")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${variantChips}</div></div>`;
  }

  const listItems = list.length
    ? list
        .map((ex) => {
          const subCount = classStudents.filter((s) => hasSubmittedExam(s.id, ex)).length;
          return `
        <div class="today-list-item">
          <div>
            <div class="exam-name ui" style="font-weight:600;font-size:14px;">${escapeHtml(ex.examLabel)}</div>
            <div class="note" style="margin-top:2px;">${subCount} / ${classStudents.length} submitted</div>
          </div>
          <button class="btn btn-ghost btn-small" data-action="plan-remove-exam" data-id="${ex.id}">Remove</button>
        </div>`;
        })
        .join("")
    : `<div class="note">No exams added yet for this class today.</div>`;

  const progressRows = classStudents.length
    ? classStudents
        .map((s) => {
          const dots = list
            .map((ex) => {
              const done = hasSubmittedExam(s.id, ex);
              return `<span class="dot ${done ? "done" : "pending"}"></span>`;
            })
            .join("");
          return `
        <div class="student-progress-row">
          <div class="student-name ui" style="font-weight:600;font-size:14px;">${escapeHtml(s.name)}</div>
          <div class="dots">${dots || '<span class="note">—</span>'}</div>
        </div>`;
        })
        .join("")
    : `<div class="note">No students in this class yet.</div>`;

  return `
    <div>
      <div class="field">${label("Class")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${classChips}</div></div>

      <div class="card" style="margin-bottom:24px;">
        <div class="field">${label("Subject")}<div style="display:flex;flex-wrap:wrap;gap:10px;">${subjectChips}</div></div>
        <div class="field">${label("Exam to add")}<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;">${paperChips}</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;">${yearChips}</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;">${sessionChips}</div>
          ${variantBlock}
        </div>
        <button class="btn btn-primary" data-action="plan-add-exam">+ Add to today's list</button>
        <div class="note">Add as many exams as you're assigning today — each gets added to the list below.</div>
      </div>

      <div class="section-heading">Today's list — ${escapeHtml(cls.name)}</div>
      <div class="card" style="margin-bottom:24px;">${listItems}</div>

      <div class="section-heading">Who's done what</div>
      <div class="card">
        ${progressRows}
        ${list.length ? `<div class="note" style="margin-top:14px;">Each dot is one of today's ${list.length} assigned exam${list.length === 1 ? "" : "s"} — filled means submitted.</div>` : ""}
      </div>
    </div>
  `;
}

function hasSubmittedExam(studentId, plannedExam) {
  // Match on paper/year/session/variant, not literal examKey, since a planned
  // exam's subject (chosen by the teacher when adding it) may differ from a
  // given student's own enrolled subject (e.g. AS vs full A Level both have Paper 1).
  return STATE.submissions.some(
    (s) =>
      s.studentId === studentId &&
      s.paper === plannedExam.paper &&
      s.year === plannedExam.year &&
      s.session === plannedExam.session &&
      s.variant === plannedExam.variant
  );
}

function renderOverviewTab() {
  if (STATE.students.length === 0) {
    return `<div class="card">${emptyState("Add students to the roster to see activity here.")}</div>`;
  }
  const summary = STATE.students
    .map((s) => {
      const subs = STATE.submissions.filter((sub) => sub.studentId === s.id);
      const last = subs.length
        ? subs.reduce((latest, sub) => (new Date(sub.submittedAt) > new Date(latest.submittedAt) ? sub : latest))
        : null;
      return { student: s, count: subs.length, daysSince: last ? daysSince(last.submittedAt) : null };
    })
    .sort((a, b) => {
      if (a.daysSince == null) return -1;
      if (b.daysSince == null) return 1;
      return b.daysSince - a.daysSince;
    });

  const quiet = summary.filter((s) => s.daysSince == null || s.daysSince >= 7);
  const active = summary.filter((s) => s.daysSince != null && s.daysSince < 7);

  const quietRows = quiet
    .map(
      ({ student, daysSince: d }) => `
      <div style="display:flex;justify-content:space-between;padding:9px 12px;background:var(--surface-2);border-radius:8px;">
        <span style="font-weight:600;font-size:14px;">${escapeHtml(student.name)}</span>
        <span class="ui" style="font-size:13px;color:var(--ink-soft);">${d == null ? "Never submitted" : `${d} day${d === 1 ? "" : "s"} ago`}</span>
      </div>
    `
    )
    .join("");

  const activeRows = active
    .map(
      ({ student, daysSince: d, count }) => `
      <div style="display:flex;justify-content:space-between;padding:9px 12px;">
        <span style="font-weight:600;font-size:14px;">${escapeHtml(student.name)}</span>
        <span class="ui" style="font-size:13px;color:var(--ink-soft);">${count} logged · last ${d === 0 ? "today" : `${d}d ago`}</span>
      </div>
    `
    )
    .join("");

  return `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div class="card">
        <h3 style="margin:0 0 4px;font-size:16px;">Needs a nudge</h3>
        <p class="ui" style="font-size:13px;color:var(--ink-soft);margin:0 0 16px;">No submission in the last 7 days, or none yet.</p>
        ${quiet.length === 0 ? emptyState("Everyone has submitted something this week.") : `<div style="display:flex;flex-direction:column;gap:8px;">${quietRows}</div>`}
      </div>
      <div class="card">
        <h3 style="margin:0 0 16px;font-size:16px;">Active this week</h3>
        ${active.length === 0 ? emptyState("No recent activity yet.") : `<div style="display:flex;flex-direction:column;gap:8px;">${activeRows}</div>`}
      </div>
    </div>
  `;
}

/* ---------------- DIFFICULT QUESTIONS TAB (class-aware) ---------------- */

let questionsTabState = { examFilter: "all", classFilter: "all", showResolved: false };

function isResolved(examKey_, norm) {
  return !!STATE.resolvedQuestions[`${examKey_}::${norm}`];
}

function renderQuestionsTab() {
  const { examFilter, classFilter, showResolved } = questionsTabState;

  // Determine which students are visible given the class filter
  const visibleStudentIds =
    classFilter === "all"
      ? null // null = no restriction
      : new Set(STATE.students.filter((s) => (s.classIds || []).includes(classFilter)).map((s) => s.id));

  const relevantSubmissions = STATE.submissions.filter((sub) => {
    if (!sub.difficultQuestions?.length) return false;
    if (visibleStudentIds && !visibleStudentIds.has(sub.studentId)) return false;
    return true;
  });

  const examMap = new Map();
  for (const sub of relevantSubmissions) {
    if (!examMap.has(sub.examKey)) {
      examMap.set(sub.examKey, { examKey: sub.examKey, examLabel: sub.examLabel, questions: new Map() });
    }
    const group = examMap.get(sub.examKey);
    for (const q of sub.difficultQuestions) {
      const norm = q.toLowerCase().replace(/\s+/g, "");
      if (!group.questions.has(norm)) group.questions.set(norm, { display: q, students: [], norm });
      group.questions.get(norm).students.push(sub.studentName);
    }
  }
  const examGroups = Array.from(examMap.values()).sort((a, b) => a.examLabel.localeCompare(b.examLabel));
  const visibleGroups = examFilter === "all" ? examGroups : examGroups.filter((g) => g.examKey === examFilter);

  const classOptions = STATE.classes
    .map((c) => `<option value="${c.id}" ${classFilter === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");
  const examOptions = examGroups
    .map((g) => `<option value="${g.examKey}" ${examFilter === g.examKey ? "selected" : ""}>${escapeHtml(g.examLabel)}</option>`)
    .join("");

  const filterBar = `
    <div class="ui" style="display:flex;gap:14px;margin-bottom:18px;align-items:center;flex-wrap:wrap;">
      <select id="qt-class-filter">
        <option value="all" ${classFilter === "all" ? "selected" : ""}>All classes</option>
        ${classOptions}
      </select>
      <select id="qt-exam-filter">
        <option value="all" ${examFilter === "all" ? "selected" : ""}>All exams</option>
        ${examOptions}
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-soft);cursor:pointer;">
        <input id="qt-show-resolved" type="checkbox" style="width:auto;" ${showResolved ? "checked" : ""} />
        Show resolved
      </label>
    </div>
  `;

  if (examGroups.length === 0) {
    const msg =
      classFilter === "all"
        ? "No difficult questions logged yet. Once students submit results with flagged questions, they'll show up here grouped by exam."
        : "No difficult questions logged yet for this class.";
    return `${STATE.classes.length > 0 ? filterBar : ""}<div class="card">${emptyState(msg)}</div>`;
  }

  const groupCards = visibleGroups
    .map((g) => {
      const allQ = Array.from(g.questions.values()).sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }));
      const qList = showResolved ? allQ : allQ.filter((q) => !isResolved(g.examKey, q.norm));
      if (qList.length === 0) return "";
      const rows = qList
        .map((q, i) => {
          const resolved = isResolved(g.examKey, q.norm);
          return `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:10px 0;${i < qList.length - 1 ? "border-bottom:1px solid var(--line);" : ""}opacity:${resolved ? 0.45 : 1};">
            <div style="font-weight:700;font-size:16px;min-width:64px;${resolved ? "text-decoration:line-through;" : ""}">Q${escapeHtml(q.display)}</div>
            <div class="ui" style="flex:1;font-size:13px;color:var(--ink-soft);text-align:right;">
              ${q.students.length} ${q.students.length === 1 ? "student" : "students"}: ${escapeHtml(q.students.join(", "))}
            </div>
            <button class="ui" data-action="toggle-resolved" data-examkey="${g.examKey}" data-norm="${q.norm}"
              style="font-size:12px;font-weight:600;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:${resolved ? "var(--surface-2)" : "var(--good)"};color:${resolved ? "var(--ink-soft)" : "#fff"};cursor:pointer;white-space:nowrap;">
              ${resolved ? "Reopen" : "Resolved"}
            </button>
          </div>
        `;
        })
        .join("");
      return `
        <div class="card">
          <h3 style="margin:0 0 16px;font-size:18px;">${escapeHtml(g.examLabel)}</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">${rows}</div>
        </div>
      `;
    })
    .join("");

  return `${filterBar}<div style="display:flex;flex-direction:column;gap:18px;">${groupCards}</div>`;
}

/* ---------------- STUDENT PROGRESS TAB (teacher view) ---------------- */

let studentsTabState = { selectedId: null };

function renderStudentsTab() {
  if (STATE.students.length === 0) {
    return `<div class="card">${emptyState("No students in the roster yet. Add them under Manage Roster.")}</div>`;
  }
  if (!studentsTabState.selectedId) studentsTabState.selectedId = STATE.students[0].id;
  const selected = studentsTabState.selectedId;
  const student = STATE.students.find((s) => s.id === selected);

  const sideList = STATE.students
    .map(
      (s) => `
      <button class="ui" data-action="students-select" data-id="${s.id}"
        style="text-align:left;padding:10px 12px;border-radius:8px;border:none;background:${selected === s.id ? "var(--accent-tint)" : "transparent"};cursor:pointer;font-weight:${selected === s.id ? 700 : 500};font-size:14px;width:100%;">
        ${escapeHtml(s.name)}
      </button>
    `
    )
    .join("");

  let detail = "";
  if (student) {
    const subs = STATE.submissions
      .filter((s) => s.studentId === student.id)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const avgPct = subs.length ? Math.round((subs.reduce((acc, s) => acc + s.score / s.total, 0) / subs.length) * 100) : null;
    const avgTime = subs.length ? Math.round(subs.reduce((acc, s) => acc + s.minutes, 0) / subs.length) : null;
    const flagCount = subs.reduce((acc, s) => acc + (s.difficultQuestions?.length || 0), 0);

    const historyItems = subs
      .map(
        (s) => `
        <div style="border-bottom:1px solid var(--line);padding-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <div style="font-weight:700;font-size:15px;">${escapeHtml(s.examLabel)}</div>
            <div class="ui" style="font-size:13px;color:var(--ink-soft);">${new Date(s.submittedAt).toLocaleDateString()}</div>
          </div>
          <div class="ui" style="font-size:13px;color:var(--ink-soft);margin-top:4px;">
            ${s.score}/${s.total} (${Math.round((s.score / s.total) * 100)}%) · ${s.minutes} min
            ${s.difficultQuestions?.length ? ` · stuck on ${s.difficultQuestions.map((q) => `Q${q}`).join(", ")}` : ""}
          </div>
        </div>
      `
      )
      .join("");

    const classNames = (student.classIds || [])
      .map((cid) => STATE.classes.find((c) => c.id === cid)?.name)
      .filter(Boolean);

    detail = `
      <div class="card" style="margin-bottom:16px;">
        <h3 style="margin:0 0 4px;">${escapeHtml(student.name)}</h3>
        <div class="ui" style="font-size:13px;color:var(--ink-soft);margin-bottom:18px;">
          ${escapeHtml(SUBJECTS[student.subject]?.label || "")}${classNames.length ? " · " + escapeHtml(classNames.join(", ")) : ""}
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;">
          ${statBlock("Exams logged", subs.length)}
          ${statBlock("Avg score", avgPct != null ? avgPct + "%" : "—")}
          ${statBlock("Avg time", avgTime != null ? avgTime + " min" : "—")}
          ${statBlock("Questions flagged", flagCount)}
        </div>
        ${subs.length >= 2 ? `<div style="margin-top:18px;">${label("Score trend")}${trendChartSvg(subs)}</div>` : ""}
      </div>
      <div class="card">
        <h4 style="margin:0 0 14px;font-size:14px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-soft);">History</h4>
        ${subs.length === 0 ? emptyState("No submissions yet.") : `<div style="display:flex;flex-direction:column;gap:12px;">${historyItems}</div>`}
      </div>
    `;
  }

  return `
    <div style="display:flex;gap:20px;flex-wrap:wrap;">
      <div style="min-width:220px;flex:0 0 220px;">
        <div class="card" style="padding:10px;">
          <div style="display:flex;flex-direction:column;gap:4px;">${sideList}</div>
        </div>
      </div>
      <div style="flex:1;min-width:280px;">${detail}</div>
    </div>
  `;
}

/* ---------------- MANAGE ROSTER TAB ---------------- */

let rosterTabState = {
  newName: "", newSubject: "olevel", newClassIds: [],
  confirmDeleteId: null, editingId: null, editName: "", editSubject: "olevel", editClassIds: [],
  confirmResetId: null,
};

function classCheckboxes(selectedIds, prefix) {
  if (STATE.classes.length === 0) {
    return `<div class="ui" style="font-size:12px;color:var(--ink-soft);">No classes yet — create one under Manage Classes.</div>`;
  }
  return STATE.classes
    .map(
      (c) => `
      <label class="ui" style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0;cursor:pointer;">
        <input type="checkbox" data-${prefix}-class="${c.id}" ${selectedIds.includes(c.id) ? "checked" : ""} style="width:auto;" />
        ${escapeHtml(c.name)}
      </label>
    `
    )
    .join("");
}

function renderRosterTab() {
  const st = rosterTabState;

  const rosterRows = STATE.students
    .map((s) => {
      if (st.editingId === s.id) {
        return `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;padding:10px 4px;border-bottom:1px solid var(--line);">
            <div style="flex:1 1 180px;">
              <input id="roster-edit-name" class="ui" value="${escapeHtml(st.editName)}" />
            </div>
            <div style="flex:1 1 160px;">
              <select id="roster-edit-subject" class="ui">
                ${Object.entries(SUBJECTS).map(([k, def]) => `<option value="${k}" ${st.editSubject === k ? "selected" : ""}>${def.label}</option>`).join("")}
              </select>
            </div>
            <div style="flex:1 1 160px;">
              ${classCheckboxes(st.editClassIds, "edit")}
            </div>
            <button class="btn btn-primary" data-action="roster-save-edit" data-id="${s.id}">Save</button>
            <button class="btn btn-quiet" data-action="roster-cancel-edit">Cancel</button>
          </div>
        `;
      }
      const classNames = (s.classIds || []).map((cid) => STATE.classes.find((c) => c.id === cid)?.name).filter(Boolean);
      let actions = "";
      if (st.confirmDeleteId === s.id) {
        actions = `
          <button class="btn btn-danger" data-action="roster-delete-confirm" data-id="${s.id}">Confirm</button>
          <button class="btn btn-quiet" data-action="roster-delete-cancel">Cancel</button>
        `;
      } else if (st.confirmResetId === s.id) {
        actions = `
          <button class="btn btn-danger" data-action="roster-reset-confirm" data-id="${s.id}">Confirm reset</button>
          <button class="btn btn-quiet" data-action="roster-reset-cancel">Cancel</button>
        `;
      } else {
        actions = `
          <button class="btn btn-quiet" data-action="roster-start-edit" data-id="${s.id}">Edit</button>
          ${s.passcode ? `<button class="btn btn-ghost" data-action="roster-reset-start" data-id="${s.id}">Reset code</button>` : ""}
          <button class="btn btn-ghost" data-action="roster-delete-start" data-id="${s.id}">Remove</button>
        `;
      }
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line);flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:600;">${escapeHtml(s.name)}</div>
            <div class="ui" style="font-size:12px;color:var(--ink-soft);">
              ${escapeHtml(SUBJECTS[s.subject]?.label || "")} · ${s.passcode ? "code set" : "no code yet"}${classNames.length ? " · " + escapeHtml(classNames.join(", ")) : ""}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">${actions}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div>
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin:0 0 16px;font-size:16px;">Add a student</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;">
          <div style="flex:1 1 200px;">
            ${label("Name")}
            <input id="roster-new-name" class="ui" placeholder="Full name" value="${escapeHtml(st.newName)}" />
          </div>
          <div style="flex:1 1 180px;">
            ${label("Level")}
            <select id="roster-new-subject" class="ui">
              ${Object.entries(SUBJECTS).map(([k, def]) => `<option value="${k}" ${st.newSubject === k ? "selected" : ""}>${def.label}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1 1 180px;">
            ${label("Classes")}
            ${classCheckboxes(st.newClassIds, "new")}
          </div>
          <button class="btn btn-primary" data-action="roster-add" style="align-self:flex-end;">Add</button>
        </div>
        <div class="ui" style="font-size:12px;color:var(--ink-soft);margin-top:10px;">
          If two students share a name, add a last initial to tell them apart. They'll set their own 4-digit code the first time they log in.
        </div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 16px;font-size:16px;">Roster (${STATE.students.length})</h3>
        ${STATE.students.length === 0 ? emptyState("No students added yet.") : `<div style="display:flex;flex-direction:column;gap:8px;">${rosterRows}</div>`}
      </div>
    </div>
  `;
}

/* ---------------- MANAGE CLASSES TAB ---------------- */

let classesTabState = { newName: "", confirmDeleteId: null };

function renderClassesTab() {
  const st = classesTabState;
  const rows = STATE.classes
    .map((c) => {
      const memberCount = STATE.students.filter((s) => (s.classIds || []).includes(c.id)).length;
      const actions =
        st.confirmDeleteId === c.id
          ? `
          <button class="btn btn-danger" data-action="class-delete-confirm" data-id="${c.id}">Confirm</button>
          <button class="btn btn-quiet" data-action="class-delete-cancel">Cancel</button>
        `
          : `<button class="btn btn-ghost" data-action="class-delete-start" data-id="${c.id}">Remove</button>`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line);">
          <div>
            <div style="font-weight:600;">${escapeHtml(c.name)}</div>
            <div class="ui" style="font-size:12px;color:var(--ink-soft);">${memberCount} student${memberCount === 1 ? "" : "s"}</div>
          </div>
          <div style="display:flex;gap:8px;">${actions}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div>
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin:0 0 16px;font-size:16px;">Create a class</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
          <div style="flex:1 1 240px;">
            ${label("Class name")}
            <input id="class-new-name" class="ui" placeholder="e.g. Tuesday AS Group" value="${escapeHtml(st.newName)}" />
          </div>
          <button class="btn btn-primary" data-action="class-add">Create</button>
        </div>
        <div class="ui" style="font-size:12px;color:var(--ink-soft);margin-top:10px;">
          Assign students to classes from Manage Roster. A student can belong to more than one class — useful for AS+A2 or AS+Combined Science students.
        </div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 16px;font-size:16px;">Classes (${STATE.classes.length})</h3>
        ${STATE.classes.length === 0 ? emptyState("No classes created yet.") : `<div style="display:flex;flex-direction:column;gap:4px;">${rows}</div>`}
      </div>
    </div>
  `;
}

/* ---------------- LOCK TOTALS TAB (pre-2023 exams) ---------------- */

function modeOf(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return { value: best, count: bestCount, total: arr.length };
}

function renderLockTotalsTab() {
  // Group all submissions for pre-cutoff exams by examKey
  const preCutoff = STATE.submissions.filter((s) => s.year < LOCK_CUTOFF_YEAR);
  const byExam = new Map();
  for (const sub of preCutoff) {
    if (!byExam.has(sub.examKey)) {
      byExam.set(sub.examKey, { examKey: sub.examKey, examLabel: sub.examLabel, totals: [] });
    }
    byExam.get(sub.examKey).totals.push(sub.total);
  }

  const rows = Array.from(byExam.values())
    .sort((a, b) => a.examLabel.localeCompare(b.examLabel))
    .map((group) => {
      const { value, count, total } = modeOf(group.totals);
      const isLocked = STATE.lockedTotals?.[group.examKey] != null;
      const lockedValue = STATE.lockedTotals?.[group.examKey];
      const action = isLocked
        ? `<button class="btn btn-ghost btn-small" data-action="unlock-total" data-examkey="${group.examKey}">Unlock</button>`
        : `<button class="btn btn-primary btn-small" data-action="lock-total" data-examkey="${group.examKey}" data-value="${value}">Lock at ${value}</button>`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);gap:14px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;font-size:14px;" class="ui">${escapeHtml(group.examLabel)}</div>
            <div class="ui" style="font-size:12px;color:var(--ink-soft);margin-top:2px;">
              ${isLocked
                ? `Locked at ${lockedValue}`
                : `Most common total: ${value} (${count} of ${total} submission${total === 1 ? "" : "s"})`}
            </div>
          </div>
          ${action}
        </div>
      `;
    })
    .join("");

  return `
    <div>
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin:0 0 8px;font-size:16px;">How this works</h3>
        <p class="ui" style="font-size:13px;color:var(--ink-soft);margin:0;line-height:1.6;">
          Exams from ${LOCK_CUTOFF_YEAR} onward always use fixed total marks and can't be changed by students.
          Exams before ${LOCK_CUTOFF_YEAR} stay editable until you lock them here — once locked, the total is fixed
          for everyone going forward, the same way as newer exams.
        </p>
      </div>
      <div class="card">
        <h3 style="margin:0 0 16px;font-size:16px;">Exams with submitted data</h3>
        ${byExam.size === 0 ? emptyState("No pre-" + LOCK_CUTOFF_YEAR + " submissions yet.") : rows}
      </div>
    </div>
  `;
}

let logTabState = { confirmDeleteId: null };

function renderLogTab() {
  const sorted = [...STATE.submissions].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  if (sorted.length === 0) {
    return `<div class="card">${emptyState("No submissions logged yet.")}</div>`;
  }
  const rows = sorted
    .map((s) => {
      const actions =
        logTabState.confirmDeleteId === s.id
          ? `
          <span style="display:flex;gap:6px;">
            <button data-action="log-delete-confirm" data-id="${s.id}" style="color:var(--danger);background:none;border:none;cursor:pointer;font-weight:700;">Confirm</button>
            <button data-action="log-delete-cancel" style="color:var(--ink-soft);background:none;border:none;cursor:pointer;">Cancel</button>
          </span>
        `
          : `<button data-action="log-delete-start" data-id="${s.id}" style="color:var(--ink-soft);background:none;border:none;cursor:pointer;">Delete</button>`;
      return `
        <tr class="row-border">
          <td style="font-weight:600;">${escapeHtml(s.studentName)}</td>
          <td>${escapeHtml(s.examLabel)}</td>
          <td>${s.score}/${s.total} (${Math.round((s.score / s.total) * 100)}%)</td>
          <td>${s.minutes} min</td>
          <td>${s.difficultQuestions?.length ? escapeHtml(s.difficultQuestions.map((q) => `Q${q}`).join(", ")) : "—"}</td>
          <td style="color:var(--ink-soft);white-space:nowrap;">${new Date(s.submittedAt).toLocaleDateString()}</td>
          <td>${actions}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
        <button class="btn btn-quiet" data-action="log-export-csv">Export CSV</button>
      </div>
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="overflow-x:auto;">
          <table class="ui">
            <thead>
              <tr style="background:var(--surface-2);">
                <th>Student</th><th>Exam</th><th>Score</th><th>Time</th><th>Flagged</th><th>Submitted</th><th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function exportCsv() {
  const sorted = [...STATE.submissions].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  const headers = ["Student", "Subject", "Paper", "Year", "Session", "Variant", "Score", "Total", "Percent", "Minutes", "Flagged Questions", "Submitted At"];
  const rows = sorted.map((s) => [
    s.studentName,
    SUBJECTS[s.subject]?.label ?? s.subject,
    s.paper, s.year,
    sessionByKey(s.session)?.label ?? s.session,
    s.variant, s.score, s.total,
    `${Math.round((s.score / s.total) * 100)}%`,
    s.minutes,
    (s.difficultQuestions || []).join("; "),
    s.submittedAt,
  ]);
  const escape = (val) => {
    const str = String(val ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `exam-submissions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- SETTINGS TAB ---------------- */

let settingsTabState = { current: "", next: "", confirm: "", error: "", msg: "" };

function renderSettingsTab() {
  const st = settingsTabState;
  return `
    <div class="card" style="max-width:420px;">
      <h3 style="margin:0 0 16px;font-size:16px;">Change teacher passcode</h3>
      <div class="field">${label("Current passcode")}<input id="settings-current" type="password" value="${escapeHtml(st.current)}" /></div>
      <div class="field">${label("New passcode")}<input id="settings-next" type="password" value="${escapeHtml(st.next)}" /></div>
      <div class="field">${label("Confirm new passcode")}<input id="settings-confirm" type="password" value="${escapeHtml(st.confirm)}" /></div>
      ${st.error ? `<div class="ui" style="color:var(--danger);font-size:13px;margin-bottom:12px;">${escapeHtml(st.error)}</div>` : ""}
      ${st.msg ? `<div class="ui" style="color:var(--good);font-size:13px;margin-bottom:12px;">${escapeHtml(st.msg)}</div>` : ""}
      <button class="btn btn-primary" data-action="settings-save">Save passcode</button>
    </div>
  `;
}

/* ============================================================
   EVENT HANDLING (delegated, since we re-render via innerHTML)
   ============================================================ */

function attachHandlers() {
  root().addEventListener("click", onRootClick);
  root().addEventListener("input", onRootInput);
  root().addEventListener("change", onRootChange);
  root().addEventListener("keydown", onRootKeydown);
}

function onRootKeydown(e) {
  if (e.key !== "Enter") return;
  if (e.target.id === "roster-new-name") { e.preventDefault(); document.querySelector('[data-action="roster-add"]')?.click(); }
  if (e.target.id === "class-new-name") { e.preventDefault(); document.querySelector('[data-action="class-add"]')?.click(); }
  if (e.target.id === "teacher-passcode-input") { e.preventDefault(); teacherPasscodeSubmit(); }
  if (e.target.id === "student-search") { e.preventDefault(); }
}

function onRootInput(e) {
  const id = e.target.id;
  if (id === "student-search") { STUDENT_SESSION.searchQuery = e.target.value; renderPickStudentInPlace(); }
  else if (id === "form-score") { getFormState().score = e.target.value; }
  else if (id === "form-total") { const f = getFormState(); f.totalInput = e.target.value; f.editTotal = true; }
  else if (id === "form-minutes") { getFormState().minutes = e.target.value; }
  else if (id === "form-difficult") { getFormState().difficultRaw = e.target.value; }
  else if (id === "roster-new-name") { rosterTabState.newName = e.target.value; }
  else if (id === "roster-edit-name") { rosterTabState.editName = e.target.value; }
  else if (id === "class-new-name") { classesTabState.newName = e.target.value; }
  else if (id === "settings-current") { settingsTabState.current = e.target.value; }
  else if (id === "settings-next") { settingsTabState.next = e.target.value; }
  else if (id === "settings-confirm") { settingsTabState.confirm = e.target.value; }
}

// Lightweight partial re-render for the search box so focus isn't lost on every keystroke
function renderPickStudentInPlace() {
  const cardEl = root().querySelector(".card");
  if (cardEl && STUDENT_SESSION.step === "pick-student") {
    cardEl.outerHTML = renderPickStudent();
  }
}

function onRootChange(e) {
  const id = e.target.id;
  if (id === "roster-new-subject") rosterTabState.newSubject = e.target.value;
  else if (id === "roster-edit-subject") rosterTabState.editSubject = e.target.value;
  else if (id === "qt-class-filter") { questionsTabState.classFilter = e.target.value; render(); }
  else if (id === "qt-exam-filter") { questionsTabState.examFilter = e.target.value; render(); }
  else if (id === "qt-show-resolved") { questionsTabState.showResolved = e.target.checked; render(); }
  else if (e.target.matches("[data-new-class]")) {
    const cid = e.target.getAttribute("data-new-class");
    toggleInArray(rosterTabState.newClassIds, cid, e.target.checked);
  } else if (e.target.matches("[data-edit-class]")) {
    const cid = e.target.getAttribute("data-edit-class");
    toggleInArray(rosterTabState.editClassIds, cid, e.target.checked);
  }
}

function toggleInArray(arr, val, shouldHave) {
  const idx = arr.indexOf(val);
  if (shouldHave && idx === -1) arr.push(val);
  if (!shouldHave && idx !== -1) arr.splice(idx, 1);
}

async function onRootClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.getAttribute("data-action");

  switch (action) {
    /* ---- Gate ---- */
    case "goto-student":
      STUDENT_SESSION = { studentId: null, step: "pick-student", searchQuery: "" };
      setView({ mode: "student" });
      break;
    case "goto-teacher":
      TEACHER_SESSION = { tab: "overview" };
      teacherGateState = { code: "", error: "" };
      setView({ mode: "teacher", teacherAuthed: false });
      break;
    case "exit-to-gate":
      setView({ mode: null });
      break;

    /* ---- Teacher passcode ---- */
    case "teacher-passcode-submit":
      teacherPasscodeSubmit();
      break;

    /* ---- Student: pick / code flow ---- */
    case "pick-student": {
      const id = el.getAttribute("data-id");
      const student = STATE.students.find((s) => s.id === id);
      STUDENT_SESSION.studentId = id;
      if (student?.passcode) {
        STUDENT_SESSION.step = "enter-code";
        STUDENT_SESSION.enterCode = { code: "", error: "", attempts: 0 };
      } else {
        STUDENT_SESSION.step = "set-code";
        STUDENT_SESSION.setCode = { code: "", confirmStage: false, error: "" };
      }
      render();
      break;
    }
    case "exit-to-pick-student":
      STUDENT_SESSION = { studentId: null, step: "pick-student", searchQuery: "" };
      render();
      break;
    case "setcode-digit": {
      const d = el.getAttribute("data-digit");
      handleSetCodeDigit(d);
      break;
    }
    case "setcode-delete": {
      const sc = STUDENT_SESSION.setCode;
      sc.code = sc.code.slice(0, -1);
      render();
      break;
    }
    case "entercode-digit": {
      const d = el.getAttribute("data-digit");
      handleEnterCodeDigit(d);
      break;
    }
    case "entercode-delete": {
      const ec = STUDENT_SESSION.enterCode;
      ec.code = ec.code.slice(0, -1);
      render();
      break;
    }

    /* ---- Student menu / nav ---- */
    case "goto-menu":
      STUDENT_SESSION.step = "menu";
      render();
      break;
    case "goto-progress":
      STUDENT_SESSION.step = "progress";
      render();
      break;
    case "goto-form":
      STUDENT_SESSION.step = "form";
      STUDENT_SESSION.form = null; // fresh form
      render();
      break;
    case "goto-form-prefilled": {
      const ek = el.getAttribute("data-examkey");
      const student = STATE.students.find((s) => s.id === STUDENT_SESSION.studentId);
      const todaysExams = getStudentTodaysExams(student);
      const ex = todaysExams.find((e) => e.examKey === ek);
      STUDENT_SESSION.step = "form";
      if (ex) {
        STUDENT_SESSION.form = {
          paper: ex.paper, year: ex.year, session: ex.session, variant: ex.variant,
          score: "", totalInput: "", editTotal: false,
          minutes: "", difficultRaw: "", error: "",
        };
      } else {
        STUDENT_SESSION.form = null;
      }
      render();
      break;
    }

    /* ---- Submit form ---- */
    case "form-set-paper":
      getFormState().paper = Number(el.getAttribute("data-value"));
      render();
      break;
    case "form-set-year":
      getFormState().year = Number(el.getAttribute("data-value"));
      render();
      break;
    case "form-set-session": {
      const f = getFormState();
      f.session = el.getAttribute("data-value");
      f.variant = f.session === "mar" ? 2 : null;
      f.totalInput = ""; f.editTotal = false;
      render();
      break;
    }
    case "form-set-variant":
      getFormState().variant = Number(el.getAttribute("data-value"));
      render();
      break;
    case "form-submit":
      await handleFormSubmit();
      break;

    /* ---- Teacher tabs ---- */
    case "teacher-tab":
      TEACHER_SESSION.tab = el.getAttribute("data-value");
      render();
      break;

    /* ---- Difficult Questions ---- */
    case "toggle-resolved": {
      const ek = el.getAttribute("data-examkey");
      const norm = el.getAttribute("data-norm");
      const rk = `${ek}::${norm}`;
      const next = { ...STATE.resolvedQuestions };
      if (next[rk]) delete next[rk]; else next[rk] = true;
      await saveState({ resolvedQuestions: next });
      break;
    }

    /* ---- Student Progress (teacher) ---- */
    case "students-select":
      studentsTabState.selectedId = el.getAttribute("data-id");
      render();
      break;

    /* ---- Roster ---- */
    case "roster-add":
      await handleRosterAdd();
      break;
    case "roster-start-edit": {
      const id = el.getAttribute("data-id");
      const s = STATE.students.find((x) => x.id === id);
      rosterTabState.editingId = id;
      rosterTabState.editName = s.name;
      rosterTabState.editSubject = s.subject;
      rosterTabState.editClassIds = [...(s.classIds || [])];
      render();
      break;
    }
    case "roster-cancel-edit":
      rosterTabState.editingId = null;
      render();
      break;
    case "roster-save-edit": {
      const id = el.getAttribute("data-id");
      await handleRosterSaveEdit(id);
      break;
    }
    case "roster-delete-start":
      rosterTabState.confirmDeleteId = el.getAttribute("data-id");
      render();
      break;
    case "roster-delete-cancel":
      rosterTabState.confirmDeleteId = null;
      render();
      break;
    case "roster-delete-confirm": {
      const id = el.getAttribute("data-id");
      await handleRosterDelete(id);
      break;
    }
    case "roster-reset-start":
      rosterTabState.confirmResetId = el.getAttribute("data-id");
      render();
      break;
    case "roster-reset-cancel":
      rosterTabState.confirmResetId = null;
      render();
      break;
    case "roster-reset-confirm": {
      const id = el.getAttribute("data-id");
      await handleRosterResetCode(id);
      break;
    }

    /* ---- Classes ---- */
    case "class-add":
      await handleClassAdd();
      break;
    case "class-delete-start":
      classesTabState.confirmDeleteId = el.getAttribute("data-id");
      render();
      break;
    case "class-delete-cancel":
      classesTabState.confirmDeleteId = null;
      render();
      break;
    case "class-delete-confirm": {
      const id = el.getAttribute("data-id");
      await handleClassDelete(id);
      break;
    }

    /* ---- Log ---- */
    case "log-delete-start":
      logTabState.confirmDeleteId = el.getAttribute("data-id");
      render();
      break;
    case "log-delete-cancel":
      logTabState.confirmDeleteId = null;
      render();
      break;
    case "log-delete-confirm": {
      const id = el.getAttribute("data-id");
      const next = STATE.submissions.filter((s) => s.id !== id);
      logTabState.confirmDeleteId = null;
      await saveState({ submissions: next });
      break;
    }
    case "log-export-csv":
      exportCsv();
      break;

    /* ---- Lock Totals ---- */
    case "lock-total": {
      const ek = el.getAttribute("data-examkey");
      const value = Number(el.getAttribute("data-value"));
      const next = { ...STATE.lockedTotals, [ek]: value };
      await saveState({ lockedTotals: next });
      break;
    }
    case "unlock-total": {
      const ek = el.getAttribute("data-examkey");
      const next = { ...STATE.lockedTotals };
      delete next[ek];
      await saveState({ lockedTotals: next });
      break;
    }

    /* ---- Today's Plan ---- */
    case "plan-select-class":
      planTabState.selectedClassId = el.getAttribute("data-value");
      render();
      break;
    case "plan-set-subject":
      planTabState.formSubject = el.getAttribute("data-value");
      planTabState.formPaper = null;
      render();
      break;
    case "plan-set-paper":
      planTabState.formPaper = Number(el.getAttribute("data-value"));
      render();
      break;
    case "plan-set-year":
      planTabState.formYear = Number(el.getAttribute("data-value"));
      render();
      break;
    case "plan-set-session":
      planTabState.formSession = el.getAttribute("data-value");
      planTabState.formVariant = planTabState.formSession === "mar" ? 2 : 1;
      render();
      break;
    case "plan-set-variant":
      planTabState.formVariant = Number(el.getAttribute("data-value"));
      render();
      break;
    case "plan-add-exam":
      await handlePlanAddExam();
      break;
    case "plan-remove-exam": {
      const id = el.getAttribute("data-id");
      await handlePlanRemoveExam(id);
      break;
    }

    /* ---- Settings ---- */
    case "settings-save":
      await handleSettingsSave();
      break;
  }
}

/* ============================================================
   HANDLER LOGIC
   ============================================================ */

function handleSetCodeDigit(d) {
  const sc = STUDENT_SESSION.setCode;
  if (sc.code.length >= 4) return;
  sc.code += d;
  render();
  if (sc.code.length === 4) {
    setTimeout(async () => {
      if (!sc.confirmStage) {
        sc.firstCode = sc.code;
        sc.code = "";
        sc.confirmStage = true;
        render();
      } else {
        if (sc.code === sc.firstCode) {
          const studentId = STUDENT_SESSION.studentId;
          const next = STATE.students.map((s) => (s.id === studentId ? { ...s, passcode: sc.code } : s));
          await saveState({ students: next });
          STUDENT_SESSION.step = "menu";
          render();
        } else {
          sc.error = "Codes didn't match — let's try again.";
          sc.code = "";
          sc.confirmStage = false;
          sc.firstCode = "";
          render();
        }
      }
    }, 150);
  }
}

function handleEnterCodeDigit(d) {
  const ec = STUDENT_SESSION.enterCode;
  if (ec.attempts >= 2) return;
  if (ec.code.length >= 4) return;
  ec.code += d;
  render();
  if (ec.code.length === 4) {
    setTimeout(() => {
      const student = STATE.students.find((s) => s.id === STUDENT_SESSION.studentId);
      if (ec.code === student.passcode) {
        STUDENT_SESSION.step = "menu";
        render();
      } else {
        ec.attempts += 1;
        ec.code = "";
        const triesLeft = 2 - ec.attempts;
        ec.error = triesLeft <= 0
          ? "Too many incorrect attempts. Ask your teacher to reset your code."
          : `Incorrect code. ${triesLeft} attempt${triesLeft === 1 ? "" : "s"} left.`;
        render();
      }
    }, 150);
  }
}

async function handleFormSubmit() {
  const f = getFormState();
  const student = STATE.students.find((s) => s.id === STUDENT_SESSION.studentId);
  f.error = "";

  const scoreNum = Number(f.score);
  const totalNum = Number(f.totalInput);
  const minNum = Number(f.minutes);
  if (Number.isNaN(scoreNum) || Number.isNaN(totalNum) || Number.isNaN(minNum)) {
    f.error = "Marks and time need to be numbers.";
    render();
    return;
  }
  if (scoreNum > totalNum) {
    f.error = "Score can't be higher than the total.";
    render();
    return;
  }

  const questions = f.difficultRaw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const ek = examKey(student.subject, f.paper, f.year, f.session, f.variant);
  const resolved = resolveExamTotal(student.subject, f.paper, f.year, ek);

  // Enforce locked totals regardless of what was in the (disabled) input,
  // in case of any stale client state.
  const finalTotal = resolved.locked && resolved.total != null ? resolved.total : totalNum;
  if (scoreNum > finalTotal) {
    f.error = "Score can't be higher than the total.";
    render();
    return;
  }

  const submission = {
    id: uid(),
    studentId: student.id,
    studentName: student.name,
    subject: student.subject,
    paper: f.paper, year: f.year, session: f.session, variant: f.variant,
    examKey: ek,
    examLabel: examLabel(student.subject, f.paper, f.year, f.session, f.variant),
    score: scoreNum, total: finalTotal, minutes: minNum,
    difficultQuestions: questions,
    submittedAt: new Date().toISOString(),
  };

  const patch = { submissions: [...STATE.submissions, submission] };
  // Only pre-2023, unlocked exams can have their total remembered as a running override
  if (!resolved.locked && (resolved.total == null || finalTotal !== resolved.total)) {
    patch.examTotals = { ...STATE.examTotals, [ek]: finalTotal };
  }

  await saveState(patch);
  STUDENT_SESSION.step = "done";
  STUDENT_SESSION.form = null;
  render();
}

async function handleRosterAdd() {
  const st = rosterTabState;
  if (!st.newName.trim()) return;
  const newStudent = {
    id: uid(),
    name: st.newName.trim(),
    subject: st.newSubject,
    classIds: [...st.newClassIds],
    passcode: null,
  };
  await saveState({ students: [...STATE.students, newStudent] });
  rosterTabState.newName = "";
  rosterTabState.newClassIds = [];
  render();
}

async function handleRosterSaveEdit(id) {
  const st = rosterTabState;
  if (!st.editName.trim()) return;
  const next = STATE.students.map((s) =>
    s.id === id ? { ...s, name: st.editName.trim(), subject: st.editSubject, classIds: [...st.editClassIds] } : s
  );
  rosterTabState.editingId = null;
  await saveState({ students: next });
}

async function handleRosterDelete(id) {
  const nextStudents = STATE.students.filter((s) => s.id !== id);
  const nextSubmissions = STATE.submissions.filter((s) => s.studentId !== id);
  rosterTabState.confirmDeleteId = null;
  await saveState({ students: nextStudents, submissions: nextSubmissions });
}

async function handleRosterResetCode(id) {
  const next = STATE.students.map((s) => (s.id === id ? { ...s, passcode: null } : s));
  rosterTabState.confirmResetId = null;
  await saveState({ students: next });
}

async function handleClassAdd() {
  const name = classesTabState.newName.trim();
  if (!name) return;
  const newClass = { id: uid(), name };
  classesTabState.newName = "";
  await saveState({ classes: [...STATE.classes, newClass] });
}

async function handleClassDelete(id) {
  const nextClasses = STATE.classes.filter((c) => c.id !== id);
  // also remove this class from any student's classIds
  const nextStudents = STATE.students.map((s) => ({
    ...s,
    classIds: (s.classIds || []).filter((cid) => cid !== id),
  }));
  classesTabState.confirmDeleteId = null;
  await saveState({ classes: nextClasses, students: nextStudents });
}

async function handlePlanAddExam() {
  const cls = STATE.classes.find((c) => c.id === planTabState.selectedClassId);
  if (!cls) return;
  const { formSubject, formPaper, formYear, formSession } = planTabState;
  const variant = formSession === "mar" ? 2 : planTabState.formVariant;
  const ek = examKey(formSubject, formPaper, formYear, formSession, variant);
  const exam = {
    id: uid(),
    subject: formSubject, paper: formPaper, year: formYear, session: formSession, variant,
    examKey: ek,
    examLabel: examLabel(formSubject, formPaper, formYear, formSession, variant),
  };
  const existing = STATE.todaysPlan[cls.id] || [];
  // avoid adding the exact same exam twice to the same class's list
  if (existing.some((e) => e.examKey === ek)) return;
  const next = { ...STATE.todaysPlan, [cls.id]: [...existing, exam] };
  await saveState({ todaysPlan: next });
}

async function handlePlanRemoveExam(examId) {
  const cls = STATE.classes.find((c) => c.id === planTabState.selectedClassId);
  if (!cls) return;
  const existing = STATE.todaysPlan[cls.id] || [];
  const next = { ...STATE.todaysPlan, [cls.id]: existing.filter((e) => e.id !== examId) };
  await saveState({ todaysPlan: next });
}

async function handleSettingsSave() {
  const st = settingsTabState;
  st.error = ""; st.msg = "";
  const stored = STATE.teacherPasscode || DEFAULT_TEACHER_PASSCODE;
  if (st.current !== stored) {
    st.error = "Current passcode is incorrect.";
    render();
    return;
  }
  if (st.next.length < 4) {
    st.error = "New passcode should be at least 4 characters.";
    render();
    return;
  }
  if (st.next !== st.confirm) {
    st.error = "New passcode and confirmation don't match.";
    render();
    return;
  }
  await saveState({ teacherPasscode: st.next });
  settingsTabState = { current: "", next: "", confirm: "", error: "", msg: "Passcode updated." };
  render();
}

/* ============================================================
   BOOT
   ============================================================ */

initStore().then(() => render());

// Expose internals for debugging (harmless in production; lets you inspect
// window.STATE from the browser console if something looks off).
window.__getState = () => STATE;
window.__saveState = saveState;
Object.defineProperty(window, "STATE", { get: () => STATE });
window.saveState = saveState;
window.render = render;
Object.defineProperty(window, "VIEW", {
  get: () => VIEW,
  set: (v) => { VIEW = v; },
});
Object.defineProperty(window, "STUDENT_SESSION", {
  get: () => STUDENT_SESSION,
  set: (v) => { STUDENT_SESSION = v; },
});
Object.defineProperty(window, "TEACHER_SESSION", {
  get: () => TEACHER_SESSION,
  set: (v) => { TEACHER_SESSION = v; },
});
