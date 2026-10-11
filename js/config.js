// Preencha com os valores reais do seu projeto Google Cloud.
//
// CLIENT_ID is committed with its real value on purpose (same for
// SPREADSHEET_ID routing in js/tenants.js) — this app has no backend, so
// anything the browser needs is visible in the deployed JS to anyone who
// opens the live app regardless of what's in the git repo. The real access
// boundary is each spreadsheet's Google Drive sharing + the OAuth Client's
// "Authorized JavaScript origins", not secrecy of these IDs.
//
// SPREADSHEET_ID / SHEET_NAME are no longer fixed here — they're resolved per
// logged-in user from js/tenants.js (multi-company support) and written onto
// this object at sign-in, in js/app.js.
const CONFIG = {
  CLIENT_ID: "421144448289-jfiiagc3pij4qoaoq0m2dhnjuda4ua8t.apps.googleusercontent.com",
  // The Google account that owns the Apps Script server (it must be an Editor of every company spreadsheet). Shown in a help message when the server cannot write to a sheet.
  CONTA_DO_SISTEMA: "finanponto@gmail.com",
  SPREADSHEET_ID: "",
  SHEET_NAME: "Lançamento",
  // URL of the deployed Apps Script gateway (see apps-script/LEIA-ME.md). When
  // set, every spreadsheet read/write goes through it: people no longer need
  // the spreadsheet shared with their own Google account, and the login only
  // asks for their email. Left empty, the app talks to the Sheets API directly
  // with each person's own token (the original mode; needs Drive sharing).
  GATEWAY_URL: "https://script.google.com/macros/s/AKfycbx9Q-4sPBqQBwURw9eC5Xq0q-fgrpiI62dKrwPb6Ja7MhIP7vi5-uWiZJ7sTepZ8c0z/exec",
  SCOPES: "",
};

// Gateway mode needs only the email scope (identity). Direct mode also needs
// Sheets read/write, plus email to pick the company (see js/tenants.js).
CONFIG.SCOPES = CONFIG.GATEWAY_URL
  ? "https://www.googleapis.com/auth/userinfo.email"
  : "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";

// Push notifications (2026-10-10, see CLAUDE.md "Notificações push"): Firebase
// Cloud Messaging. The apiKey here is a public, per-project web key — Firebase
// documents it as safe to ship in client code (unlike CLIENT_ID above it is
// not even the real access boundary for anything); the real server-side
// secret (the service account key) lives only in the Apps Script project's
// Script Properties, never in this file or the repo.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAn7U2v2Pc47vwRLbUumOC1OkjSSQvfkPw",
  authDomain: "finan-push.firebaseapp.com",
  projectId: "finan-push",
  storageBucket: "finan-push.firebasestorage.app",
  messagingSenderId: "564828633413",
  appId: "1:564828633413:web:620496958eab957b1da62c",
};
const FIREBASE_VAPID_KEY = "BE1ImzVAAYTow1dm0cE-e-DC0sI-M3iaoAH1ICmJnz5mNoeZgun8-YN-V6qrD4s7SpqxMNHHYTN1G-fSdg6-MjY";
