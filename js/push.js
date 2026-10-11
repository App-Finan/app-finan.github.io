// Push notifications (2026-10-10, requested alongside a WhatsApp test contact
// — see CLAUDE.md "Notificações push"): opt-in, per device, via Firebase
// Cloud Messaging. Apps Script has no native Web Push/VAPID (elliptic-curve)
// crypto, but it DOES have RSA signing (Utilities.computeRsaSha256Signature),
// which is exactly what authenticating as a Firebase service account needs —
// that is the whole reason Firebase sits in the middle here instead of this
// app talking raw Web Push itself. Gateway mode only (direct mode has no
// server action to register a token against).

function pushDisponivel() {
  return Boolean(
    CONFIG.GATEWAY_URL &&
    window.firebase &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

let firebaseAppPronto = false;
function garantirFirebaseApp() {
  if (firebaseAppPronto) return;
  firebaseAppPronto = true;
  firebase.initializeApp(FIREBASE_CONFIG);
}

// A "notification" message (as opposed to a silent "data" message) only
// auto-shows itself via the service worker when the app is in the
// BACKGROUND — Firebase routes it here instead while the tab is focused, so
// without this the person would see nothing at all while the app is open.
function escutarMensagensEmPrimeiroPlano() {
  garantirFirebaseApp();
  firebase.messaging().onMessage((payload) => {
    const notificacao = payload && payload.notification;
    if (!notificacao) return;
    try {
      new Notification(notificacao.title || "Finan.", { body: notificacao.body || "" });
    } catch (err) {
      console.error(err);
    }
  });
}

function prepararCartaoNotificacoes() {
  const cartao = document.getElementById("ajustes-notificacoes-card");
  const botao = document.getElementById("btn-ativar-notificacoes");
  if (!cartao || !botao) return;
  if (!CONFIG.GATEWAY_URL) {
    cartao.hidden = true;
    return;
  }
  if (!pushDisponivel()) {
    botao.disabled = true;
    document.getElementById("notificacoes-status").textContent = "Este navegador não aceita notificações.";
    return;
  }
  if (Notification.permission === "denied") {
    botao.disabled = true;
    document.getElementById("notificacoes-status").textContent = "As notificações foram bloqueadas para este site — ative de novo nas configurações do navegador.";
  } else if (Notification.permission === "granted") {
    botao.textContent = "Notificações ativadas";
    escutarMensagensEmPrimeiroPlano();
  }
}

async function ativarNotificacoes() {
  const botao = document.getElementById("btn-ativar-notificacoes");
  const status = document.getElementById("notificacoes-status");
  if (!pushDisponivel()) {
    status.textContent = "Este navegador não aceita notificações.";
    return;
  }
  botao.disabled = true;
  status.textContent = "Pedindo permissão...";
  try {
    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") {
      status.textContent = "Permissão não concedida.";
      botao.disabled = false;
      return;
    }
    garantirFirebaseApp();
    const registro = await navigator.serviceWorker.ready;
    const token = await firebase.messaging().getToken({ vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: registro });
    if (!token) throw new Error("Não foi possível gerar o token de notificação.");
    await gatewayCall("registrarPush", { pushToken: token }, accessToken);
    status.textContent = "Notificações ativadas neste aparelho.";
    botao.textContent = "Notificações ativadas";
    escutarMensagensEmPrimeiroPlano();
  } catch (err) {
    console.error(err);
    status.textContent = "Erro ao ativar: " + mensagemDoErro(err);
    botao.disabled = false;
  }
}

let notificacoesHandlersProntos = false;
function setupNotificacoesAjustes() {
  if (notificacoesHandlersProntos) return;
  notificacoesHandlersProntos = true;
  prepararCartaoNotificacoes();
  const botao = document.getElementById("btn-ativar-notificacoes");
  if (botao) botao.addEventListener("click", ativarNotificacoes);
}
