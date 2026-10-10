let tokenClient = null;
let accessToken = null;

const SESSION_TOKEN_KEY = "ipanema_gis_access_token";
const SESSION_EXPIRES_KEY = "ipanema_gis_token_expires_at";
// What Google said the token may do, and when it was issued (see handleSignedIn):
// a brand-new token is not asked about again over the network.
const SESSION_SCOPES_KEY = "ipanema_gis_token_scopes";
const SESSION_ISSUED_KEY = "ipanema_gis_token_issued_at";
// A session of the e-mail + password login (not Google): which kind, and who.
const SESSION_KIND_KEY = "ipanema_auth_kind";
const SESSION_EMAIL_KEY = "ipanema_auth_email";
// "Manter conectado neste aparelho" — a password session opted into surviving
// a closed tab/app, kept in localStorage (device-wide, like the theme/sidebar
// prefs) instead of sessionStorage. Google logins never use this: the token
// itself only ever lasts ~1h regardless of where it's stored, and the
// sessionStorage-only rule for it is a deliberate security choice (see
// CLAUDE.md's Security posture) that this feature does not touch.
const REMEMBER_TOKEN_KEY = "financegold_lembrar_token";
const REMEMBER_EXPIRES_KEY = "financegold_lembrar_expira_em";
const REMEMBER_EMAIL_KEY = "financegold_lembrar_email";

function waitForGoogleIdentity(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Tempo esgotado ao carregar o Google Identity Services."));
        return;
      }
      setTimeout(check, 50);
    })();
  });
}

function saveTokenToSession(token, expiresInSeconds, scopes) {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(SESSION_EXPIRES_KEY, String(Date.now() + expiresInSeconds * 1000));
    sessionStorage.setItem(SESSION_ISSUED_KEY, String(Date.now()));
    sessionStorage.removeItem(SESSION_KIND_KEY);
    sessionStorage.removeItem(SESSION_EMAIL_KEY);
    if (typeof scopes === "string" && scopes) sessionStorage.setItem(SESSION_SCOPES_KEY, scopes);
    else sessionStorage.removeItem(SESSION_SCOPES_KEY);
  } catch (err) {
    console.warn("Não foi possível salvar a sessão:", err);
  }
}

// Returns a still-valid token from this tab's session, or null. Falls back to
// a "lembrada" (remembered) password session in localStorage when this tab's
// own sessionStorage has nothing — e.g. the tab/app was closed and reopened —
// and, when found, promotes it into sessionStorage too, so everything else
// (tipoDeSessao, emailDaSessao, signOut...) keeps reading from one place.
function loadValidTokenFromSession() {
  try {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    const expiresAt = Number(sessionStorage.getItem(SESSION_EXPIRES_KEY) || 0);
    const safetyMarginMs = 30_000;
    if (token && expiresAt > Date.now() + safetyMarginMs) {
      accessToken = token;
      return token;
    }
  } catch (err) {
    console.warn("Não foi possível ler a sessão:", err);
  }
  const lembrada = loadRememberedSenhaSession();
  if (lembrada) {
    saveSenhaSession(lembrada.token, lembrada.expiresAt, lembrada.email); // this tab's sessionStorage only
    accessToken = lembrada.token;
    return lembrada.token;
  }
  return null;
}

// Keeps a session of the password login for this tab (same keys the reload
// logic already reads, plus the kind and the e-mail: there is no Google to ask).
// "lembrar" also keeps it in localStorage (see loadValidTokenFromSession above).
function saveSenhaSession(token, expiraEmMs, email, lembrar) {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(SESSION_EXPIRES_KEY, String(expiraEmMs));
    sessionStorage.setItem(SESSION_ISSUED_KEY, String(Date.now()));
    sessionStorage.removeItem(SESSION_SCOPES_KEY);
    sessionStorage.setItem(SESSION_KIND_KEY, "senha");
    sessionStorage.setItem(SESSION_EMAIL_KEY, email);
  } catch (err) {
    console.warn("Não foi possível salvar a sessão:", err);
  }
  if (lembrar) saveRememberedSenhaSession(token, expiraEmMs, email);
  accessToken = token;
}

function saveRememberedSenhaSession(token, expiresAt, email) {
  try {
    localStorage.setItem(REMEMBER_TOKEN_KEY, token);
    localStorage.setItem(REMEMBER_EXPIRES_KEY, String(expiresAt));
    localStorage.setItem(REMEMBER_EMAIL_KEY, email);
  } catch (err) {
    console.warn("Não foi possível salvar a sessão lembrada:", err);
  }
}

function loadRememberedSenhaSession() {
  try {
    const token = localStorage.getItem(REMEMBER_TOKEN_KEY);
    const expiresAt = Number(localStorage.getItem(REMEMBER_EXPIRES_KEY) || 0);
    const safetyMarginMs = 30_000;
    if (token && expiresAt > Date.now() + safetyMarginMs) {
      return { token, expiresAt, email: localStorage.getItem(REMEMBER_EMAIL_KEY) || "" };
    }
  } catch (err) {
    console.warn("Não foi possível ler a sessão lembrada:", err);
  }
  return null;
}

function clearRememberedSenhaSession() {
  try {
    localStorage.removeItem(REMEMBER_TOKEN_KEY);
    localStorage.removeItem(REMEMBER_EXPIRES_KEY);
    localStorage.removeItem(REMEMBER_EMAIL_KEY);
  } catch (err) {
    // ignore
  }
}

function tipoDeSessao() {
  try {
    return sessionStorage.getItem(SESSION_KIND_KEY) === "senha" ? "senha" : "google";
  } catch (err) {
    return "google";
  }
}

function emailDaSessao() {
  try {
    return sessionStorage.getItem(SESSION_EMAIL_KEY) || "";
  } catch (err) {
    return "";
  }
}

// The scopes Google reported when it issued this tab's token (null when unknown).
function loadSessionScopes() {
  try {
    return sessionStorage.getItem(SESSION_SCOPES_KEY) || null;
  } catch (err) {
    return null;
  }
}

// A token issued moments ago may not yet be known everywhere at Google, so a
// "not valid" answer about it is worth asking again before believing it.
function tokenEmitidoHaPouco() {
  try {
    const emitido = Number(sessionStorage.getItem(SESSION_ISSUED_KEY) || 0);
    return emitido > 0 && Date.now() - emitido < 90000;
  } catch (err) {
    return false;
  }
}

function clearTokenSession() {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_EXPIRES_KEY);
    sessionStorage.removeItem(SESSION_SCOPES_KEY);
    sessionStorage.removeItem(SESSION_ISSUED_KEY);
    sessionStorage.removeItem(SESSION_KIND_KEY);
    sessionStorage.removeItem(SESSION_EMAIL_KEY);
  } catch (err) {
    // ignore
  }
  clearRememberedSenhaSession();
  accessToken = null;
}

async function initAuth(onSignedIn, onLoginError) {
  await waitForGoogleIdentity();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (response) => {
      if (response.error) {
        console.error("Erro de autenticação com o Google:", response);
        if (onLoginError) onLoginError(response.error);
        return;
      }
      accessToken = response.access_token;
      saveTokenToSession(accessToken, response.expires_in, response.scope);
      onSignedIn(accessToken);
    },
    // The window did not open (blocked pop-up) or was closed: tell the person instead of doing nothing.
    error_callback: (erro) => {
      console.error("Janela de login do Google:", erro);
      if (onLoginError) onLoginError(erro && erro.type ? erro.type : "unknown");
    },
  });
}

function requestAccessToken() {
  if (!tokenClient) {
    console.error("Token client do Google ainda não está pronto.");
    return;
  }
  tokenClient.requestAccessToken();
}

async function getTokenScopes(token) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  // 4xx = Google says the token is not valid (null). 5xx / 429 = Google is having a
  // moment: that is NOT a reason to sign the person out, so it is reported as a failure to retry.
  if (response.status >= 500 || response.status === 429) {
    const falha = new Error(`O Google não respondeu agora (${response.status}).`);
    falha.status = response.status;
    throw falha;
  }
  if (!response.ok) return null;
  const data = await response.json();
  return data.scope || "";
}

function hasAllScopes(grantedScopeString, requiredScopeString) {
  const granted = new Set(grantedScopeString.split(" ").filter(Boolean));
  return requiredScopeString
    .split(" ")
    .filter(Boolean)
    .every((scope) => granted.has(scope));
}

async function fetchUserEmail(token) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    const falha = new Error(`Falha ao identificar a conta Google (${response.status}): ${errorBody}`);
    falha.status = response.status;
    throw falha;
  }
  const data = await response.json();
  return data.email;
}

function signOut() {
  const token = accessToken;
  const eraGoogle = tipoDeSessao() === "google";
  clearTokenSession();
  if (eraGoogle && token && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(token, () => {});
  }
}
