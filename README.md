# MAPS Combinator · Founder Workspace

A small web app for running a 12-week MAPS Combinator cohort of teen builders and founders.

- **Cohort map**: every startup's 12 weekly milestones. Founders submit evidence, then an instructor verifies it (or marks it "needs work").
- **KPIs**: baseline vs. weekly numbers for interviews, users, weekly active users, paying customers and revenue.
- **Friday standups**: shipped, numbers, blockers, next week, confidence 1–5.
- **Friday digest**: an instructor-only AI summary of the week, written by Claude.

Revenue milestones (like Week 10's first $500) are **coached goals, not promises**, and the app's copy says so.

## Stack

No framework and no build step.

| Path | What it is |
|---|---|
| `public/index.html`, `public/app.js` | The whole UI. Plain HTML/JS using the Firebase JS SDK from the gstatic CDN. |
| `public/firebase-config.js` | Firebase web config. Not a secret; safe to commit. |
| `api/digest.js` | Vercel serverless function that writes the digest with Claude. |
| `firestore.rules` | All access control. |
| `tests/rules.test.js` | Tests for the rules (Firestore emulator). |
| `firebase.json` | Firestore rules deploy target and emulator ports. |
| `vercel.json` | Serves `public/`, gives the digest function 120s. |

## Who can do what

Access is decided by two Firestore collections, keyed by **lowercase email**:

- `admins/{email}` are **instructors**. You create these **by hand** in the Firebase console. The app can never write them.
- `members/{email}` are **founders**: `{ email, name, startupId }`. Instructors add and remove them on the Manage page.

| | Instructor | Founder | Anyone else signed in |
|---|---|---|---|
| See cohort map, startups, standups, milestones | ✓ | ✓ | ✗ |
| Post/edit standups | ✓ | own startup only | ✗ |
| Submit milestone evidence | ✓ | own startup, not once verified | ✗ |
| Verify milestones, set baselines, cohort date | ✓ | ✗ | ✗ |
| Manage members | ✓ | ✗ | ✗ |
| Read or generate digests | ✓ | ✗ | ✗ |

Founders can edit their startup's one-liner but not its baseline, so "baseline vs. now" can't drift.

## Data model

```
admins/{email}                          {}  (created by hand)
members/{email}                         { email, name, startupId, addedBy, addedAt }
settings/cohort                         { name, startDate: "YYYY-MM-DD" }  (week 1 starts here)
startups/{id}                           { name, oneLiner, baseline: {interviews, users, wau, paying, revenue}, createdAt }
startups/{id}/milestones/{1..12}        { status: submitted|verified|needs_work, evidence, link?, submittedBy, submittedAt, note?, reviewedBy?, reviewedAt? }
startups/{id}/standups/{1..12}          { week, shipped, numbers: {...}, blockers, nextWeek, confidence, postedBy, postedAt }
digests/{1..12}                         { week, text, model, generatedBy, generatedAt }
```

Each program week has one standup per startup, for that week's Friday. Posting again updates it.

## How the digest works

1. The instructor's browser collects the week's data: startup names, one-liners, numbers, standups and milestone status. Founder emails and names are **not** included.
2. It calls `POST /api/digest` with the user's Firebase ID token.
3. The function verifies the token with Google (Identity Toolkit `accounts:lookup`) and checks it was issued for `FIREBASE_PROJECT_ID`.
4. It reads `admins/{email}` from Firestore **using the caller's own token**, so `firestore.rules` decides. No service account is needed.
5. It calls the Claude Messages API and returns the text. The browser saves it to `digests/{week}`.

## Setup

1. **Firebase**: create a project, enable **Authentication → Google**, create a **Firestore** database, then:
   ```
   npm i -g firebase-tools
   firebase login
   firebase use --add            # pick your project
   firebase deploy --only firestore:rules
   ```
   Put the web app config (Project settings → Your apps → Web) into `public/firebase-config.js`.
2. **Instructor access**: in the Firestore console, create collection `admins` with a document whose ID is your email in lowercase (no fields needed).
3. **Vercel**: `vercel link`, then `vercel deploy --prod`. Set these environment variables (Project → Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | from console.anthropic.com |
   | `FIREBASE_API_KEY` | the `apiKey` from `firebase-config.js` |
   | `FIREBASE_PROJECT_ID` | the `projectId` from `firebase-config.js` |
   | `ANTHROPIC_MODEL` | optional; defaults to `claude-opus-5-5` |

   Redeploy after setting them.
4. **Authorized domain**: add your Vercel domain (e.g. `maps-combinator-workspace.vercel.app`) under Firebase **Authentication → Settings → Authorized domains**, or Google sign-in will fail there.

Never commit API keys. Keep local values in `.env.local`, which is git-ignored (see `.env.example`).

## Local development and tests

```
npm install
npm run test:rules        # Firestore rules tests (needs Java 11+ for the emulator)
```

To click through the app against local emulators: run `firebase emulators:start --only auth,firestore --project demo-maps`, serve the repo with `vercel dev`, and open `http://localhost:3000/?emulators`. The `?emulators` switch only works on localhost.
