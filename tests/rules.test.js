// Firestore security rules tests. Run with: npm run test:rules (needs Java for the emulator).
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp,
} from "firebase/firestore";

let env;

const INSTRUCTOR = "coach@example.com";
const FOUNDER = "amina@example.com";
const OTHER_FOUNDER = "yusuf@example.com";
const STRANGER = "stranger@example.com";

const as = (email, verified = true) => env.authenticatedContext(email, { email, email_verified: verified }).firestore();

const numbers = { interviews: 5, users: 2, wau: 1, paying: 0, revenue: 0 };
const standup = (email, week = 1) => ({
  week, shipped: "Landing page", numbers, blockers: "", nextWeek: "More interviews",
  confidence: 4, postedBy: email, postedAt: serverTimestamp(),
});
const submission = (email) => ({
  status: "submitted", evidence: "Did 10 interviews", link: "https://example.com/notes",
  submittedBy: email, submittedAt: serverTimestamp(),
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-maps",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "admins", INSTRUCTOR), {});
    await setDoc(doc(db, "members", FOUNDER), { email: FOUNDER, name: "Amina", startupId: "s1" });
    await setDoc(doc(db, "members", OTHER_FOUNDER), { email: OTHER_FOUNDER, name: "Yusuf", startupId: "s2" });
    await setDoc(doc(db, "settings", "cohort"), { name: "Fall", startDate: "2026-09-07" });
    await setDoc(doc(db, "startups", "s1"), { name: "One", oneLiner: "", baseline: numbers });
    await setDoc(doc(db, "startups", "s2"), { name: "Two", oneLiner: "", baseline: numbers });
    await setDoc(doc(db, "startups", "s2", "milestones", "1"), { status: "verified", evidence: "x" });
  });
});

test("signed-out and non-cohort users can't read anything", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "startups", "s1")));
  await assertFails(getDoc(doc(as(STRANGER), "startups", "s1")));
  await assertFails(getDoc(doc(as(STRANGER), "settings", "cohort")));
});

test("anyone signed in can check only their own admin/member doc", async () => {
  await assertSucceeds(getDoc(doc(as(STRANGER), "admins", STRANGER)));
  await assertSucceeds(getDoc(doc(as(STRANGER), "members", STRANGER)));
  await assertFails(getDoc(doc(as(STRANGER), "admins", INSTRUCTOR)));
  await assertFails(getDoc(doc(as(FOUNDER), "members", OTHER_FOUNDER)));
  await assertFails(getDocs(collection(as(FOUNDER), "members")));
});

test("unverified emails are rejected", async () => {
  await assertFails(getDoc(doc(as(FOUNDER, false), "startups", "s1")));
});

test("nobody can write admins from the app", async () => {
  await assertFails(setDoc(doc(as(INSTRUCTOR), "admins", FOUNDER), {}));
  await assertFails(setDoc(doc(as(FOUNDER), "admins", FOUNDER), {}));
});

test("founders can't add members or change settings; instructors can", async () => {
  const member = { email: "new@example.com", name: "New", startupId: "s1" };
  await assertFails(setDoc(doc(as(FOUNDER), "members", "new@example.com"), member));
  await assertSucceeds(setDoc(doc(as(INSTRUCTOR), "members", "new@example.com"), member));
  await assertFails(setDoc(doc(as(INSTRUCTOR), "members", "New@example.com"), { ...member, email: "New@example.com" }));
  await assertFails(setDoc(doc(as(FOUNDER), "settings", "cohort"), { startDate: "2026-01-01" }));
  await assertSucceeds(setDoc(doc(as(INSTRUCTOR), "settings", "cohort"), { startDate: "2026-01-01" }));
});

test("cohort members can read the cohort map", async () => {
  await assertSucceeds(getDocs(collection(as(FOUNDER), "startups")));
  await assertSucceeds(getDocs(collection(as(FOUNDER), "startups", "s2", "standups")));
});

test("founders post standups only for their own startup, with valid data", async () => {
  await assertSucceeds(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "1"), standup(FOUNDER)));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s2", "standups", "1"), standup(FOUNDER)));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "13"), standup(FOUNDER, 13)));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "2"), standup(FOUNDER, 1)));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "1"), { ...standup(FOUNDER), confidence: 6 }));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "1"), { ...standup(FOUNDER), postedBy: OTHER_FOUNDER }));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "1"), { ...standup(FOUNDER), numbers: { ...numbers, revenue: -5 } }));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s1", "standups", "1"), { ...standup(FOUNDER), extra: true }));
});

test("founders submit evidence but can't verify", async () => {
  const ref = doc(as(FOUNDER), "startups", "s1", "milestones", "1");
  await assertSucceeds(setDoc(ref, submission(FOUNDER)));
  await assertFails(setDoc(ref, { ...submission(FOUNDER), status: "verified" }));
  await assertFails(updateDoc(ref, { status: "verified" }));
  await assertFails(setDoc(ref, { ...submission(FOUNDER), link: "javascript:alert(1)" }));
  await assertFails(setDoc(doc(as(FOUNDER), "startups", "s2", "milestones", "2"), submission(FOUNDER)));
});

test("founders can't overwrite a verified milestone", async () => {
  await assertFails(setDoc(doc(as(OTHER_FOUNDER), "startups", "s2", "milestones", "1"), submission(OTHER_FOUNDER)));
});

test("instructors verify milestones", async () => {
  await setDoc(doc(as(FOUNDER), "startups", "s1", "milestones", "3"), submission(FOUNDER));
  await assertSucceeds(updateDoc(doc(as(INSTRUCTOR), "startups", "s1", "milestones", "3"), {
    status: "verified", note: "Nice", reviewedBy: INSTRUCTOR, reviewedAt: serverTimestamp(),
  }));
});

test("founders edit only their own one-liner, never the baseline", async () => {
  await assertSucceeds(updateDoc(doc(as(FOUNDER), "startups", "s1"), { oneLiner: "Tutoring for 8th graders" }));
  await assertFails(updateDoc(doc(as(FOUNDER), "startups", "s2"), { oneLiner: "hi" }));
  await assertFails(updateDoc(doc(as(FOUNDER), "startups", "s1"), { baseline: { ...numbers, revenue: 999 } }));
  await assertFails(deleteDoc(doc(as(FOUNDER), "startups", "s1")));
  await assertSucceeds(updateDoc(doc(as(INSTRUCTOR), "startups", "s1"), { baseline: { ...numbers, users: 3 } }));
});

test("digests are instructor-only", async () => {
  await assertSucceeds(setDoc(doc(as(INSTRUCTOR), "digests", "1"), { text: "hi" }));
  await assertFails(getDoc(doc(as(FOUNDER), "digests", "1")));
  await assertFails(setDoc(doc(as(FOUNDER), "digests", "1"), { text: "hi" }));
});
