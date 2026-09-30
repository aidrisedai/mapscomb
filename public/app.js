import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Program content ----------

const MILESTONES = [
  { week: 1, title: "Talk to your customers", goal: "Log 10 customer interviews about the problem." },
  { week: 2, title: "Sharpen the problem", goal: "Reach 20 interviews and write a one-sentence problem statement: who has it worst, and why." },
  { week: 3, title: "Prototype the solution", goal: "Put a clickable prototype or mockup in front of 5 target users." },
  { week: 4, title: "Landing page + waitlist", goal: "Launch a landing page and collect your first sign-ups." },
  { week: 5, title: "Ship the MVP", goal: "Get the smallest working version into real users' hands." },
  { week: 6, title: "First 10 users", goal: "10 people outside friends and family have used it." },
  { week: 7, title: "Build from feedback", goal: "Ship 3 improvements that came directly from user feedback." },
  { week: 8, title: "Ask for money", goal: "Put a real price in front of at least 10 potential customers." },
  { week: 9, title: "First paying customer", goal: "Coached goal: work toward your first paying customer." },
  { week: 10, title: "First $500", goal: "Coached goal: stretch toward your first $500 in revenue. It's a target to aim for, not a promise." },
  { week: 11, title: "Find a growth channel", goal: "Test one channel and measure what it brings in." },
  { week: 12, title: "Demo Day", goal: "Pitch your 12-week story with your real numbers." },
];

const KPIS = [
  ["interviews", "Interviews"],
  ["users", "Users"],
  ["wau", "Weekly active"],
  ["paying", "Paying customers"],
  ["revenue", "Revenue ($)"],
];

const STATUS_LABEL = { submitted: "Submitted", verified: "Verified", needs_work: "Needs work" };

// ---------- Firebase ----------

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const useEmulators = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).has("emulators");
if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ---------- State ----------

const state = {
  user: null,
  email: "",
  isAdmin: false,
  member: null,      // members/{email} data for founders
  cohort: {},        // settings/cohort
  startups: [],      // [{id, name, oneLiner, baseline, milestones: {week: data}, standups: {week: data}}]
  members: [],       // instructors only
};

const root = document.getElementById("app");

// ---------- Helpers ----------

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function parseDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function formatDate(date) {
  return date ? date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
}

// Program week for today: 0 before the cohort starts, 1-12 during, 13 after.
function currentWeek() {
  const start = parseDate(state.cohort.startDate);
  if (!start) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today - start) / 86400000);
  if (days < 0) return 0;
  return Math.min(13, Math.floor(days / 7) + 1);
}

// The week to show by default in forms and on the map (1-12).
function focusWeek() {
  return Math.min(12, Math.max(1, currentWeek()));
}

// The Friday that falls in program week N.
function fridayOf(week) {
  const start = parseDate(state.cohort.startDate);
  if (!start) return null;
  const d = new Date(start);
  d.setDate(d.getDate() + (week - 1) * 7 + ((5 - start.getDay() + 7) % 7));
  return d;
}

function weekLabel(week) {
  const friday = fridayOf(week);
  return friday ? `Week ${week} · ${formatDate(friday)}` : `Week ${week}`;
}

function formatNumber(key, value) {
  if (value === undefined || value === null || value === "") return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return key === "revenue" ? `$${n.toLocaleString()}` : n.toLocaleString();
}

function latestStandup(startup) {
  const weeks = Object.keys(startup.standups || {}).map(Number).sort((a, b) => b - a);
  return weeks.length ? startup.standups[weeks[0]] : null;
}

function myStartupId() {
  return state.member?.startupId || "";
}

function canFounderEdit(startupId) {
  return !!state.member && myStartupId() === startupId;
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = isError ? "toast error show" : "toast show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = "toast"; }, isError ? 7000 : 3000);
}

function explainError(err) {
  console.error(err);
  if (err?.code === "permission-denied") {
    return "Permission denied. Your account isn't allowed to make that change.";
  }
  return err?.message || String(err);
}

// Runs a write, reloads data and re-renders, then confirms. The page is re-rendered
// before the confirmation so nobody types into a form that is about to be replaced.
async function run(button, action, successMessage) {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (err) {
    toast(explainError(err), true);
    if (button) button.disabled = false;
    return;
  }
  try {
    await loadAll();
    route();
    if (successMessage) toast(successMessage);
  } catch (err) {
    toast(`Saved, but refreshing failed: ${explainError(err)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function numberFrom(form, name) {
  const raw = form.elements[name].value.trim();
  const n = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${name}" must be a number of 0 or more.`);
  return n;
}

function kpisFrom(form, prefix = "") {
  return Object.fromEntries(KPIS.map(([key]) => [key, numberFrom(form, prefix + key)]));
}

// ---------- Data ----------

async function loadAll() {
  const [cohortSnap, startupsSnap] = await Promise.all([
    getDoc(doc(db, "settings", "cohort")),
    getDocs(collection(db, "startups")),
  ]);
  state.cohort = cohortSnap.exists() ? cohortSnap.data() : {};
  const startups = startupsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  await Promise.all(startups.map(async (s) => {
    const [ms, ss] = await Promise.all([
      getDocs(collection(db, "startups", s.id, "milestones")),
      getDocs(collection(db, "startups", s.id, "standups")),
    ]);
    s.milestones = Object.fromEntries(ms.docs.map((d) => [d.id, d.data()]));
    s.standups = Object.fromEntries(ss.docs.map((d) => [d.id, d.data()]));
  }));
  state.startups = startups.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  if (state.isAdmin) {
    const membersSnap = await getDocs(collection(db, "members"));
    state.members = membersSnap.docs.map((d) => d.data())
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }
}

// ---------- Auth ----------

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  if (!user) {
    renderSignedOut();
    return;
  }
  state.email = (user.email || "").toLowerCase();
  renderLoading();
  try {
    const [adminSnap, memberSnap] = await Promise.all([
      getDoc(doc(db, "admins", state.email)),
      getDoc(doc(db, "members", state.email)),
    ]);
    state.isAdmin = adminSnap.exists();
    state.member = memberSnap.exists() ? memberSnap.data() : null;
    if (!state.isAdmin && !state.member) {
      renderNotAllowed();
      return;
    }
    await loadAll();
    route();
  } catch (err) {
    root.innerHTML = `<section class="card"><h2>Something went wrong</h2><p>${esc(explainError(err))}</p>
      <button id="retry">Try again</button> <button class="secondary" id="signout">Sign out</button></section>`;
    document.getElementById("retry").onclick = () => location.reload();
    document.getElementById("signout").onclick = () => signOut(auth);
  }
});

function renderLoading() {
  renderNav();
  root.innerHTML = `<p class="muted">Loading your cohort…</p>`;
}

function renderSignedOut() {
  renderNav();
  root.innerHTML = `
    <section class="card hero">
      <h2>Founder Workspace</h2>
      <p>Your cohort's weekly milestones, numbers and Friday standups, all in one place.</p>
      <button id="signin">Sign in with Google</button>
      <p class="muted small">Use the Google account your instructor added to the cohort.</p>
    </section>`;
  document.getElementById("signin").onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      if (err?.code !== "auth/popup-closed-by-user") toast(explainError(err), true);
    }
  };
}

function renderNotAllowed() {
  renderNav();
  root.innerHTML = `
    <section class="card">
      <h2>You're not on the cohort list yet</h2>
      <p>You're signed in as <strong>${esc(state.email)}</strong>, but this email hasn't been added to the workspace.</p>
      <p>Ask your instructor to add this exact email, or sign in with a different account.</p>
      <button id="signout">Sign out</button>
    </section>`;
  document.getElementById("signout").onclick = () => signOut(auth);
}

// ---------- Navigation ----------

function renderNav() {
  const nav = document.getElementById("nav");
  if (!state.user || (!state.isAdmin && !state.member)) {
    nav.innerHTML = state.user
      ? `<span class="who">${esc(state.email)}</span><button class="link" id="nav-signout">Sign out</button>`
      : "";
  } else {
    const links = [`<a href="#/map">Cohort map</a>`];
    if (myStartupId()) links.push(`<a href="#/startup/${esc(myStartupId())}">My startup</a>`);
    if (state.isAdmin) links.push(`<a href="#/admin">Manage</a>`, `<a href="#/digest">Friday digest</a>`);
    nav.innerHTML = `${links.join("")}
      <span class="who">${esc(state.email)}${state.isAdmin ? " · instructor" : ""}</span>
      <button class="link" id="nav-signout">Sign out</button>`;
  }
  const out = document.getElementById("nav-signout");
  if (out) out.onclick = () => signOut(auth);
  const hash = location.hash || "";
  nav.querySelectorAll("a").forEach((a) => a.classList.toggle("active", hash.startsWith(a.getAttribute("href"))));
}

function route() {
  if (!state.user || (!state.isAdmin && !state.member)) return;
  const [, page, id] = (location.hash || "").split("/");
  if (page === "startup" && id) renderStartup(decodeURIComponent(id));
  else if (page === "admin" && state.isAdmin) renderAdmin();
  else if (page === "digest" && state.isAdmin) renderDigest();
  else if (page === "map") renderMap();
  else if (!state.isAdmin && myStartupId()) location.hash = `#/startup/${myStartupId()}`;
  else location.hash = "#/map";
  renderNav();
}

window.addEventListener("hashchange", route);

// ---------- Cohort map ----------

function cohortBanner() {
  const week = currentWeek();
  const start = parseDate(state.cohort.startDate);
  let status;
  if (!start) status = state.isAdmin ? `No cohort start date yet. <a href="#/admin">Set it in Manage</a>.` : "The cohort start date hasn't been set yet.";
  else if (week === 0) status = `Starts ${formatDate(start)}`;
  else if (week > 12) status = "The 12 weeks are complete";
  else status = `${weekLabel(week)} of 12`;
  return `<div class="banner"><strong>${esc(state.cohort.name || "MAPS Combinator")}</strong><span>${status}</span></div>`;
}

function renderMap() {
  const week = currentWeek();
  const header = MILESTONES.map((m) => `<th class="wk ${m.week === week ? "now" : ""}" title="${esc(m.title)}">W${m.week}</th>`).join("");
  const rows = state.startups.map((s) => {
    const cells = MILESTONES.map((m) => {
      const ms = s.milestones[m.week];
      const status = ms?.status || "";
      const mark = { verified: "✓", submitted: "•", needs_work: "!" }[status] || "";
      return `<td class="wk ${status} ${m.week === week ? "now" : ""}" title="W${m.week} ${esc(m.title)}${status ? ": " + STATUS_LABEL[status] : ""}">${mark}</td>`;
    }).join("");
    const focus = focusWeek();
    const posted = week >= 1 && s.standups[focus];
    const latest = latestStandup(s);
    const kpis = KPIS.map(([key, label]) => `<span class="kpi" title="${esc(label)}: baseline → latest">
        <small>${esc(label)}</small>${formatNumber(key, s.baseline?.[key])} → <b>${latest ? formatNumber(key, latest.numbers?.[key]) : "–"}</b></span>`).join("");
    return `<tr>
      <th class="name"><a href="#/startup/${esc(s.id)}">${esc(s.name)}</a><div class="muted small">${esc(s.oneLiner)}</div></th>
      ${cells}
      <td class="standup">${week >= 1 && week <= 12 ? (posted ? `<span class="ok">Posted</span>` : `<span class="warn">Not yet</span>`) : ""}</td>
      <td class="kpis">${kpis}</td>
    </tr>`;
  }).join("");

  root.innerHTML = `
    ${cohortBanner()}
    <section class="card">
      <h2>Cohort map</h2>
      <p class="muted small">✓ verified · • submitted, waiting on instructor · ! needs work. KPIs show baseline → latest standup.</p>
      ${state.startups.length ? `<div class="scroll"><table class="map">
        <thead><tr><th>Startup</th>${header}<th>This Friday</th><th>KPIs</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<p>No startups yet.${state.isAdmin ? ` <a href="#/admin">Add one in Manage</a>.` : ""}</p>`}
    </section>`;
}

// ---------- Startup page ----------

function renderStartup(startupId) {
  const s = state.startups.find((x) => x.id === startupId);
  if (!s) {
    root.innerHTML = `${cohortBanner()}<section class="card"><p>That startup wasn't found. <a href="#/map">Back to the cohort map</a>.</p></section>`;
    return;
  }
  const founder = canFounderEdit(s.id);
  const editOneLiner = founder || state.isAdmin;
  const week = focusWeek();

  // KPI history table: baseline + each week with a standup.
  const weeks = Object.keys(s.standups).map(Number).sort((a, b) => a - b);
  const kpiRows = [
    `<tr><th>Baseline</th>${KPIS.map(([k]) => `<td>${formatNumber(k, s.baseline?.[k])}</td>`).join("")}<td></td></tr>`,
    ...weeks.map((w) => {
      const st = s.standups[w];
      return `<tr><th>W${w}</th>${KPIS.map(([k]) => `<td>${formatNumber(k, st.numbers?.[k])}</td>`).join("")}<td>${esc(st.confidence)}/5</td></tr>`;
    }),
  ].join("");

  const standupForm = founder ? `
    <section class="card">
      <h3>Friday standup</h3>
      <form id="standup-form" class="grid">
        <label>Week
          <select name="week">${MILESTONES.map((m) => `<option value="${m.week}" ${m.week === week ? "selected" : ""}>${esc(weekLabel(m.week))}</option>`).join("")}</select>
        </label>
        <label class="wide">What did you ship this week?<textarea name="shipped" maxlength="4000" required></textarea></label>
        <fieldset class="wide"><legend>Numbers this week (totals to date, except weekly active)</legend>
          <div class="kpi-inputs">${KPIS.map(([k, label]) => `<label>${esc(label)}<input type="number" min="0" step="any" name="${k}" required></label>`).join("")}</div>
        </fieldset>
        <label class="wide">Blockers: where are you stuck?<textarea name="blockers" maxlength="4000"></textarea></label>
        <label class="wide">Next week's plan<textarea name="nextWeek" maxlength="4000" required></textarea></label>
        <label>Confidence (1–5)
          <select name="confidence">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 3 ? "selected" : ""}>${n}</option>`).join("")}</select>
        </label>
        <div class="wide"><button type="submit">Post standup</button> <span class="muted small" id="standup-note"></span></div>
      </form>
    </section>` : "";

  const milestoneRows = MILESTONES.map((m) => {
    const ms = s.milestones[m.week];
    const status = ms?.status || "";
    const link = safeUrl(ms?.link);
    const evidence = ms ? `
      <div class="evidence">
        <p>${esc(ms.evidence)}</p>
        ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a></p>` : ""}
        ${ms.note ? `<p class="note"><strong>Instructor note:</strong> ${esc(ms.note)}</p>` : ""}
      </div>` : "";
    const submitForm = founder && status !== "verified" ? `
      <details ${m.week === week || status === "needs_work" ? "open" : ""}><summary>${ms ? "Resubmit evidence" : "Submit evidence"}</summary>
      <form class="submit-form" data-week="${m.week}">
        <textarea name="evidence" maxlength="4000" required placeholder="What did you do? Be specific: numbers, names of tools, what you learned."></textarea>
        <input type="url" name="link" maxlength="500" placeholder="Link to evidence (optional)">
        <button type="submit">${ms ? "Resubmit" : "Submit evidence"}</button>
      </form></details>` : "";
    const reviewForm = state.isAdmin && ms ? `
      <form class="review-form" data-week="${m.week}">
        <input name="note" maxlength="1000" placeholder="Note to founders (optional)" value="${esc(ms.note || "")}">
        <button type="submit" name="status" value="verified">Verify</button>
        <button type="submit" name="status" value="needs_work" class="secondary">Needs work</button>
      </form>` : "";
    return `<li class="milestone ${status}">
      <div class="ms-head"><span class="wk-num">W${m.week}</span><strong>${esc(m.title)}</strong>
        ${status ? `<span class="pill ${status}">${STATUS_LABEL[status]}</span>` : ""}</div>
      <p class="muted small">${esc(m.goal)}</p>
      ${evidence}${submitForm}${reviewForm}
    </li>`;
  }).join("");

  const history = weeks.slice().reverse().map((w) => {
    const st = s.standups[w];
    return `<article class="standup-entry">
      <h4>${esc(weekLabel(w))} <span class="muted small">confidence ${esc(st.confidence)}/5</span></h4>
      <p><strong>Shipped:</strong> ${esc(st.shipped)}</p>
      ${st.blockers ? `<p><strong>Blockers:</strong> ${esc(st.blockers)}</p>` : ""}
      <p><strong>Next week:</strong> ${esc(st.nextWeek)}</p>
    </article>`;
  }).join("") || `<p class="muted">No standups yet.</p>`;

  root.innerHTML = `
    ${cohortBanner()}
    <section class="card">
      <h2>${esc(s.name)}</h2>
      ${editOneLiner ? `<form id="oneliner-form" class="inline">
          <input name="oneLiner" maxlength="280" value="${esc(s.oneLiner || "")}" placeholder="One-liner: what you build and for whom">
          <button type="submit" class="secondary">Save</button></form>`
        : `<p>${esc(s.oneLiner)}</p>`}
      <h3>Numbers</h3>
      <div class="scroll"><table class="kpi-table">
        <thead><tr><th></th>${KPIS.map(([, label]) => `<th>${esc(label)}</th>`).join("")}<th>Confidence</th></tr></thead>
        <tbody>${kpiRows}</tbody></table></div>
    </section>
    ${standupForm}
    <section class="card">
      <h3>12-week milestones</h3>
      <p class="muted small">Revenue milestones are coached goals to stretch toward, not promises or guarantees.</p>
      <ol class="milestones">${milestoneRows}</ol>
    </section>
    <section class="card"><h3>Standup history</h3>${history}</section>`;

  // Standup form: prefill with the chosen week's standup if one exists.
  const sf = document.getElementById("standup-form");
  if (sf) {
    const fill = () => {
      const w = Number(sf.elements.week.value);
      const st = s.standups[w];
      sf.elements.shipped.value = st?.shipped || "";
      sf.elements.blockers.value = st?.blockers || "";
      sf.elements.nextWeek.value = st?.nextWeek || "";
      sf.elements.confidence.value = String(st?.confidence || 3);
      const prev = st || latestStandup(s);
      KPIS.forEach(([k]) => { sf.elements[k].value = prev?.numbers?.[k] ?? s.baseline?.[k] ?? ""; });
      document.getElementById("standup-note").textContent = st ? "Already posted. Posting again updates it." : "";
    };
    sf.elements.week.onchange = fill;
    fill();
    sf.onsubmit = (e) => {
      e.preventDefault();
      const w = Number(sf.elements.week.value);
      run(sf.querySelector("button[type=submit]"), () => setDoc(doc(db, "startups", s.id, "standups", String(w)), {
        week: w,
        shipped: sf.elements.shipped.value.trim(),
        numbers: kpisFrom(sf),
        blockers: sf.elements.blockers.value.trim(),
        nextWeek: sf.elements.nextWeek.value.trim(),
        confidence: Number(sf.elements.confidence.value),
        postedBy: state.email,
        postedAt: serverTimestamp(),
      }), `Standup for week ${w} posted.`);
    };
  }

  const of = document.getElementById("oneliner-form");
  if (of) {
    of.onsubmit = (e) => {
      e.preventDefault();
      run(of.querySelector("button"), () => updateDoc(doc(db, "startups", s.id), {
        oneLiner: of.elements.oneLiner.value.trim(),
      }), "Saved.");
    };
  }

  root.querySelectorAll(".submit-form").forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const w = f.dataset.week;
      const link = f.elements.link.value.trim();
      if (link && !safeUrl(link)) {
        toast("The link must start with http:// or https://", true);
        return;
      }
      const data = {
        status: "submitted",
        evidence: f.elements.evidence.value.trim(),
        submittedBy: state.email,
        submittedAt: serverTimestamp(),
      };
      if (link) data.link = link;
      run(f.querySelector("button"), () => setDoc(doc(db, "startups", s.id, "milestones", w), data),
        `Week ${w} evidence submitted for review.`);
    };
  });

  root.querySelectorAll(".review-form").forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const status = e.submitter?.value || "verified";
      const w = f.dataset.week;
      run(e.submitter, () => updateDoc(doc(db, "startups", s.id, "milestones", w), {
        status,
        note: f.elements.note.value.trim(),
        reviewedBy: state.email,
        reviewedAt: serverTimestamp(),
      }), `Week ${w} marked ${STATUS_LABEL[status].toLowerCase()}.`);
    };
  });
}

// ---------- Instructor: manage ----------

function renderAdmin() {
  const startupOptions = (selected) => [`<option value="">(no startup yet)</option>`,
    ...state.startups.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? "selected" : ""}>${esc(s.name)}</option>`)].join("");

  const memberRows = state.members.map((m) => `
    <tr>
      <td>${esc(m.name)}</td><td>${esc(m.email)}</td>
      <td><select class="member-startup" data-email="${esc(m.email)}">${startupOptions(m.startupId)}</select></td>
      <td><button class="secondary member-remove" data-email="${esc(m.email)}">Remove</button></td>
    </tr>`).join("");

  const startupRows = state.startups.map((s) => `
    <tr>
      <td><a href="#/startup/${esc(s.id)}">${esc(s.name)}</a></td>
      <td><form class="baseline-form inline" data-id="${esc(s.id)}">
        ${KPIS.map(([k, label]) => `<label class="tiny">${esc(label)}<input type="number" min="0" step="any" name="${k}" value="${esc(s.baseline?.[k] ?? 0)}"></label>`).join("")}
        <button type="submit" class="secondary">Save baseline</button>
      </form></td>
    </tr>`).join("");

  root.innerHTML = `
    ${cohortBanner()}
    <section class="card">
      <h2>Cohort settings</h2>
      <form id="cohort-form" class="inline">
        <label>Cohort name<input name="name" maxlength="100" value="${esc(state.cohort.name || "")}" placeholder="MAPS Combinator Fall 2026"></label>
        <label>Week 1 starts on<input type="date" name="startDate" value="${esc(state.cohort.startDate || "")}" required></label>
        <button type="submit">Save</button>
      </form>
    </section>

    <section class="card">
      <h2>Startups</h2>
      <form id="startup-form" class="grid">
        <label>Startup name<input name="name" maxlength="100" required></label>
        <label class="wide">One-liner<input name="oneLiner" maxlength="280" placeholder="What it does and for whom"></label>
        <fieldset class="wide"><legend>Baseline KPIs (where they're starting)</legend>
          <div class="kpi-inputs">${KPIS.map(([k, label]) => `<label>${esc(label)}<input type="number" min="0" step="any" name="${k}" value="0"></label>`).join("")}</div>
        </fieldset>
        <div class="wide"><button type="submit">Add startup</button></div>
      </form>
      ${state.startups.length ? `<div class="scroll"><table class="list"><thead><tr><th>Startup</th><th>Baseline</th></tr></thead><tbody>${startupRows}</tbody></table></div>` : ""}
    </section>

    <section class="card">
      <h2>Members (founders)</h2>
      <p class="muted small">Only emails listed here can sign in as founders. Use the exact Google account email they'll sign in with.</p>
      <form id="member-form" class="inline">
        <label>Name<input name="name" maxlength="100" required></label>
        <label>Email<input type="email" name="email" required></label>
        <label>Startup<select name="startupId">${startupOptions("")}</select></label>
        <button type="submit">Add member</button>
      </form>
      ${state.members.length ? `<div class="scroll"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Startup</th><th></th></tr></thead><tbody>${memberRows}</tbody></table></div>` : `<p class="muted">No members yet.</p>`}
    </section>`;

  const cf = document.getElementById("cohort-form");
  cf.onsubmit = (e) => {
    e.preventDefault();
    run(cf.querySelector("button"), () => setDoc(doc(db, "settings", "cohort"), {
      name: cf.elements.name.value.trim(),
      startDate: cf.elements.startDate.value,
    }), "Cohort settings saved.");
  };

  const sf = document.getElementById("startup-form");
  sf.onsubmit = (e) => {
    e.preventDefault();
    run(sf.querySelector("button"), () => addDoc(collection(db, "startups"), {
      name: sf.elements.name.value.trim(),
      oneLiner: sf.elements.oneLiner.value.trim(),
      baseline: kpisFrom(sf),
      createdAt: serverTimestamp(),
    }), "Startup added.");
  };

  root.querySelectorAll(".baseline-form").forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      run(f.querySelector("button"), () => updateDoc(doc(db, "startups", f.dataset.id), { baseline: kpisFrom(f) }), "Baseline saved.");
    };
  });

  const mf = document.getElementById("member-form");
  mf.onsubmit = (e) => {
    e.preventDefault();
    const email = mf.elements.email.value.trim().toLowerCase();
    run(mf.querySelector("button"), () => setDoc(doc(db, "members", email), {
      email,
      name: mf.elements.name.value.trim(),
      startupId: mf.elements.startupId.value,
      addedBy: state.email,
      addedAt: serverTimestamp(),
    }), `${email} can now sign in.`);
  };

  root.querySelectorAll(".member-startup").forEach((sel) => {
    sel.onchange = () => run(sel, () => updateDoc(doc(db, "members", sel.dataset.email), { startupId: sel.value }), "Member updated.");
  });

  root.querySelectorAll(".member-remove").forEach((btn) => {
    btn.onclick = () => {
      if (!confirm(`Remove ${btn.dataset.email}? They'll lose access to the workspace.`)) return;
      run(btn, () => deleteDoc(doc(db, "members", btn.dataset.email)), "Member removed.");
    };
  });
}

// ---------- Instructor: Friday digest ----------

function digestPayload(week) {
  const milestone = MILESTONES[week - 1];
  return {
    cohortName: state.cohort.name || "MAPS Combinator",
    week,
    friday: fridayOf(week)?.toISOString().slice(0, 10) || null,
    milestone: { title: milestone.title, goal: milestone.goal },
    startups: state.startups.map((s) => {
      const st = s.standups[week];
      const prev = s.standups[week - 1];
      const ms = s.milestones[week];
      return {
        name: s.name,
        oneLiner: s.oneLiner || "",
        baseline: s.baseline || {},
        previousWeekNumbers: prev?.numbers || null,
        standup: st ? {
          shipped: st.shipped, numbers: st.numbers, blockers: st.blockers,
          nextWeek: st.nextWeek, confidence: st.confidence,
        } : null,
        thisWeeksMilestone: ms ? { status: ms.status, evidence: ms.evidence } : null,
        milestonesVerified: Object.values(s.milestones).filter((m) => m.status === "verified").length,
      };
    }),
  };
}

async function renderDigest() {
  const week = focusWeek();
  root.innerHTML = `
    ${cohortBanner()}
    <section class="card">
      <h2>Friday digest</h2>
      <p class="muted small">An AI summary of the week for instructors only. It reads each startup's standup, numbers and milestone status. Founder emails are not sent.</p>
      <form id="digest-form" class="inline">
        <label>Week<select name="week">${MILESTONES.map((m) => `<option value="${m.week}" ${m.week === week ? "selected" : ""}>${esc(weekLabel(m.week))}</option>`).join("")}</select></label>
        <button type="submit">Generate digest</button>
      </form>
      <div id="digest-meta" class="muted small"></div>
      <div id="digest-out" class="digest"></div>
    </section>`;

  const form = document.getElementById("digest-form");
  const out = document.getElementById("digest-out");
  const meta = document.getElementById("digest-meta");

  const showSaved = async () => {
    const w = form.elements.week.value;
    out.textContent = "";
    meta.textContent = "";
    const posted = state.startups.filter((s) => s.standups[w]).length;
    meta.textContent = `${posted} of ${state.startups.length} startups have posted a standup for week ${w}.`;
    try {
      const saved = await getDoc(doc(db, "digests", w));
      if (saved.exists()) {
        const d = saved.data();
        out.textContent = d.text;
        meta.textContent += ` Saved digest generated ${d.generatedAt?.toDate?.().toLocaleString() || ""}. Generate again to refresh it.`;
      }
    } catch (err) {
      toast(explainError(err), true);
    }
  };
  form.elements.week.onchange = showSaved;
  showSaved();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    const w = Number(form.elements.week.value);
    button.disabled = true;
    out.textContent = "Writing the digest… this can take up to a minute.";
    try {
      const token = await state.user.getIdToken();
      const res = await fetch("/api/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(digestPayload(w)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The digest service returned ${res.status}.`);
      out.textContent = body.text;
      await setDoc(doc(db, "digests", String(w)), {
        week: w,
        text: body.text,
        model: body.model || "",
        generatedBy: state.email,
        generatedAt: serverTimestamp(),
      });
      meta.textContent = `Generated and saved for week ${w}.`;
    } catch (err) {
      out.textContent = "";
      toast(explainError(err), true);
    } finally {
      button.disabled = false;
    }
  };
}
