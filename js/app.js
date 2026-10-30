const loginScreen = document.getElementById("login-screen");
const companyPickerScreen = document.getElementById("company-picker-screen");
const cadastroScreen = document.getElementById("cadastro-screen");
const acessoNegadoScreen = document.getElementById("acesso-negado-screen");
const solicitarAcessoScreen = document.getElementById("solicitar-acesso-screen");
const sistemaScreen = document.getElementById("sistema-screen");
const appShell = document.getElementById("app-shell");
const loginButton = document.getElementById("btn-login");
const logoutButton = document.getElementById("btn-logout");
const pickerLogoutButton = document.getElementById("btn-picker-logout");
const acessoNegadoLogoutButton = document.getElementById("btn-acesso-negado-sair");
const userStatus = document.getElementById("user-status");
const userAvatar = document.getElementById("user-avatar");
const loginStatus = document.getElementById("login-status");
const statusMessage = document.getElementById("status-message");
const sidebarEmpresa = document.getElementById("sidebar-empresa");
const topbarEmpresa = document.getElementById("topbar-empresa");

let currentEmail = null;
let currentIsSuperAdmin = false;
let currentCompanies = [];
let currentPedidosPendentes = 0;
let currentPedido = null;
let currentUserLinha = null;
let ajustesHandlersReady = false;
// Whether the signed-in e-mail already has an active e-mail+senha login (see
// js/completar-cadastro.js). Defaults to true (no prompt) so direct mode —
// which has no password system at all — never shows anything about it.
let currentTemSenhaAtiva = true;

function setUserIdentity(nome) {
  userStatus.textContent = nome;
  const initials = nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  userAvatar.textContent = initials || "?";
}

function setActiveCompanyLabel(name) {
  sidebarEmpresa.textContent = name;
  topbarEmpresa.textContent = name;
}

function hideAllScreens() {
  // any real screen replaces the loading screen shown while a reload resumes the session
  document.documentElement.classList.remove("retomando");
  loginScreen.hidden = true;
  companyPickerScreen.hidden = true;
  cadastroScreen.hidden = true;
  acessoNegadoScreen.hidden = true;
  solicitarAcessoScreen.hidden = true;
  sistemaScreen.hidden = true;
  document.getElementById("senha-cadastro-screen").hidden = true;
  document.getElementById("senha-esqueci-screen").hidden = true;
  document.getElementById("completar-cadastro-screen").hidden = true;
  appShell.hidden = true;
}

// Text on the loading screen (shown while a reload resumes the session).
function definirStatusDeInicio(texto) {
  const el = document.getElementById("boot-status");
  if (el) el.textContent = texto;
}

// A momentary hiccup of Google or of the app's server (they happen) must not
// throw the person back to the login screen: read-only checks made while
// signing in are tried again a couple of times before giving up. Offline,
// expired sessions and refusals (401/403) are never retried.
async function tentarVariasVezes(fn) {
  const esperas = [1200, 2500];
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (isNetworkError(err) || err.sessionExpired || err.status === 401 || err.status === 403 || i >= esperas.length) throw err;
      definirStatusDeInicio("Tentando de novo…");
      await new Promise((resolve) => setTimeout(resolve, esperas[i]));
    }
  }
}

// The scopes of a token: what Google reported when it issued it (kept for this
// tab), else asked over the network. A brand-new token is not asked about at all:
// Google's token check can briefly not know it yet, which used to bounce the
// person back to the login screen on the first try.
async function escoposDoToken(token) {
  const conhecidos = loadSessionScopes();
  if (conhecidos) return conhecidos;
  for (let i = 0; ; i += 1) {
    const escopos = await tentarVariasVezes(() => getTokenScopes(token));
    if (escopos !== null || !tokenEmitidoHaPouco() || i >= 2) return escopos;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

// Same idea for the account check right after a login.
async function emailDoToken(token) {
  for (let i = 0; ; i += 1) {
    try {
      return await tentarVariasVezes(() => fetchUserEmail(token));
    } catch (err) {
      const recusado = err.status === 401 || err.status === 400;
      if (!(recusado && tokenEmitidoHaPouco()) || i >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

// Tells the person why nothing happened after clicking "Continuar com Google".
function mostrarErroDeLogin(tipo) {
  const mensagens = {
    popup_failed_to_open: "O navegador bloqueou a janela do Google. Permita pop-ups para este site e clique de novo.",
    popup_closed: "A janela do Google foi fechada antes de terminar. Clique de novo para entrar.",
    access_denied: "O acesso não foi autorizado. Clique de novo e aceite o que o Google pedir.",
  };
  showLogin();
  loginStatus.textContent = mensagens[tipo] || `Não foi possível concluir o login com o Google (${tipo}). Tente de novo.`;
}

function showApp() {
  hideAllScreens();
  appShell.hidden = false;
}

function showLogin() {
  hideAllScreens();
  loginScreen.hidden = false;
  loginStatus.textContent = "";
  setActiveCompanyLabel("");
}

let sessionExpiredHandled = false;

// Called by gatewayCall (js/sheets.js) when the server says the Google token
// is no longer valid. The remembered company/screen are kept on purpose, so
// signing in again lands the person back where they were.
function handleSessionExpired() {
  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;
  clearTokenSession();
  showLogin();
  loginStatus.textContent = "Sua sessão expirou. Entre novamente para continuar de onde parou.";
}

function showCompanyPicker(companies, token, email) {
  const list = document.getElementById("company-picker-list");
  list.innerHTML = "";
  if (CONFIG.GATEWAY_URL && currentIsSuperAdmin) {
    // The system console is not a company: it sits above them, apart from any company data.
    const sistemaBtn = document.createElement("button");
    sistemaBtn.type = "button";
    sistemaBtn.className = "company-picker-btn company-picker-sistema";
    sistemaBtn.textContent = currentPedidosPendentes > 0 ? `Painel do sistema (${currentPedidosPendentes} pedido(s))` : "Painel do sistema";
    sistemaBtn.addEventListener("click", showSistemaScreen);
    list.appendChild(sistemaBtn);
  }
  companies.forEach((tenant) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "company-picker-btn";
    const nome = document.createElement("span");
    nome.textContent = tenant.empresa;
    btn.appendChild(nome);
    const seg = getSegmento(tenant.segmento);
    const legenda = document.createElement("small");
    legenda.className = "company-picker-seg";
    legenda.textContent = seg.nome;
    btn.appendChild(legenda);
    btn.addEventListener("click", () => resolveProfileAndEnter(tenant, token, email));
    list.appendChild(btn);
  });
  hideAllScreens();
  companyPickerScreen.hidden = false;
}

function showCadastroScreen(email, token) {
  hideAllScreens();
  cadastroScreen.hidden = false;

  document.getElementById("cadastro-email").textContent = email;
  const form = document.getElementById("cadastro-form");
  const nameInput = document.getElementById("cadastro-nome");
  const statusEl = document.getElementById("cadastro-status");
  nameInput.value = "";
  statusEl.textContent = "";

  form.onsubmit = async (event) => {
    event.preventDefault();
    const nome = nameInput.value.trim();
    if (!nome) {
      statusEl.textContent = "Digite um nome.";
      return;
    }
    statusEl.textContent = "Salvando...";
    try {
      const { perfil, linha } = await registerUsuario(email, nome, token);
      startApp(token, nome, perfil, linha);
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Erro ao salvar: ${err.message}`;
    }
  };
}

function showAcessoNegadoScreen(email, empresa, extra) {
  hideAllScreens();
  acessoNegadoScreen.hidden = false;
  const base = `O e-mail ${email} ainda não tem acesso liberado a ${empresa}. Peça para o administrador te cadastrar.`;
  document.getElementById("acesso-negado-mensagem").textContent = extra ? `${base} (${extra})` : base;
}

async function refreshLancamentosAndDashboard() {
  const records = await fetchLancamentos(accessToken);
  updateLancamentos(records);
  renderLancamentoListaTable();
}

// Only the Master decides who gets in — there is no open self-registration.
// The one exception is a brand-new company with nobody registered yet: that
// first person necessarily has to be the one setting it up (see
// registerUsuario's bootstrap rule in js/usuarios.js).
async function resolveProfileAndEnter(tenant, token, email) {
  CONFIG.SPREADSHEET_ID = tenant.spreadsheetId;
  if (tenant.sheetName) CONFIG.SHEET_NAME = tenant.sheetName;
  setActiveCompanyLabel(tenant.empresa);
  aplicarSegmento(tenant.segmento);
  rememberCompany(tenant.spreadsheetId);

  try {
    const usuario = await tentarVariasVezes(async () => {
      await ensureUsuariosSheet(token);
      await ensureFornecedoresSheet(token);
      await ensureContasSheet("pagar", token);
      await ensureContasSheet("receber", token);
      await ensureExtratoSheet(token);
      return fetchUsuario(email, token);
    });
    if (usuario) {
      // Offer the e-mail+senha "login próprio" only right after a Google
      // sign-in (a password session obviously already has one) and only when
      // it does not exist yet — "me" already told us (resolveCompaniesForEmail).
      if (CONFIG.GATEWAY_URL && tipoDeSessao() === "google" && !currentTemSenhaAtiva) {
        mostrarCompletarCadastro(email, token, usuario);
        return;
      }
      startApp(token, usuario.nome, usuario.perfil, usuario.linha);
      return;
    }

    const todos = await fetchAllUsuarios(token);
    if (todos.length === 0) {
      showCadastroScreen(email, token);
    } else {
      showAcessoNegadoScreen(email, tenant.empresa);
    }
  } catch (err) {
    console.error(err);
    if (err.sessionExpired) return;
    // Fail closed: an error checking access must never silently let someone in.
    if (err.status === 403) {
      showAcessoNegadoScreen(email, tenant.empresa, `erro ao verificar acesso: ${err.message}`);
    } else {
      // A server that is just not answering is not "access denied": keep the session so a reload resumes.
      showLogin();
      loginStatus.textContent = `Não foi possível conectar ao servidor agora. Atualize a página para tentar de novo. (${err.message})`;
    }
  }
}

async function refreshAllData() {
  const btn = document.getElementById("btn-refresh-dashboard");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Atualizando…";
  statusMessage.textContent = "Atualizando...";
  const errors = [];

  try {
    await refreshLancamentosAndDashboard();
  } catch (err) {
    console.error(err);
    errors.push(`Lançamentos: ${err.message}`);
  }

  try {
    const lookups = await fetchAllLookups(accessToken);
    populateLookupSelects(lookups);
    populateEstoqueFormSelects(lookups);
    estoqueLookups = lookups; // keep the estoque list's cached lookups (custody/sold pickers) in sync
    extratoLookups = lookups; // same reasoning: the "Criar lançamento" inline panel needs fresh options too
  } catch (err) {
    console.error(err);
    errors.push(`Listas de apoio: ${err.message}`);
  }

  try {
    await refreshEstoque();
  } catch (err) {
    console.error(err);
    errors.push(`Estoque: ${err.message}`);
  }

  try {
    await refreshFornecedores();
  } catch (err) {
    console.error(err);
    errors.push(`Fornecedores: ${err.message}`);
  }

  try {
    await refreshContas("pagar");
  } catch (err) {
    console.error(err);
    errors.push(`Contas a Pagar: ${err.message}`);
  }

  try {
    await refreshContas("receber");
  } catch (err) {
    console.error(err);
    errors.push(`Contas a Receber: ${err.message}`);
  }

  try {
    await refreshExtrato();
  } catch (err) {
    console.error(err);
    errors.push(`Extrato Bancário: ${err.message}`);
  }

  renderContasResumoDashboard(allContas.pagar, allContas.receber, allEstoque);

  if (isMaster(currentUserRole)) {
    try {
      await refreshUsuariosAdmin();
    } catch (err) {
      console.error(err);
      errors.push(`Usuários: ${err.message}`);
    }
  }

  statusMessage.textContent =
    errors.length > 0 ? `Atualizado com erros — ${errors.join(" | ")}` : "Dados atualizados.";
  btn.disabled = false;
  btn.textContent = originalLabel;
}

function setupEditarPerfilForm() {
  const btn = document.getElementById("btn-editar-perfil");
  const form = document.getElementById("editar-perfil-form");
  const nomeInput = document.getElementById("editar-perfil-nome");
  const tipoSelect = document.getElementById("editar-perfil-tipo");
  const hint = document.getElementById("editar-perfil-hint");
  const statusEl = document.getElementById("editar-perfil-status");

  function closeForm() {
    form.hidden = true;
    btn.hidden = false;
    statusEl.textContent = "";
  }

  btn.addEventListener("click", () => {
    nomeInput.value = userStatus.textContent;
    tipoSelect.value = currentUserRole;
    // The role field is always shown, but only Master can actually change it —
    // for everyone else it's visible and disabled, not hidden.
    tipoSelect.disabled = !isMaster(currentUserRole);
    hint.textContent = isMaster(currentUserRole) ? "" : "Só o Master pode alterar o tipo de perfil.";
    statusEl.textContent = "";
    form.hidden = false;
    btn.hidden = true;
  });

  document.getElementById("btn-cancelar-perfil").addEventListener("click", closeForm);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const novoNome = nomeInput.value.trim();
    if (!novoNome) {
      statusEl.textContent = "Digite um nome.";
      return;
    }

    statusEl.textContent = "Salvando...";
    try {
      await updateUsuarioNome(currentUserLinha, novoNome, accessToken);

      // Defense in depth: even if the disabled attribute were bypassed, a
      // perfil change here is only ever written for Master.
      if (isMaster(currentUserRole) && tipoSelect.value !== currentUserRole) {
        await updateUsuarioPerfil(currentUserLinha, tipoSelect.value, accessToken);
        currentUserRole = tipoSelect.value;
        applyRoleVisibility(currentUserRole);
        document.getElementById("ajustes-usuarios-section").hidden = !isMaster(currentUserRole);
      }

      setUserIdentity(novoNome);
      document.getElementById("ajustes-conta-nome").textContent = novoNome;
      statusEl.textContent = "Perfil atualizado.";
      closeForm();
    } catch (err) {
      console.error(err);
      statusEl.textContent = describeSaveError(err);
    }
  });
}

function setupAjustesHandlers() {
  if (ajustesHandlersReady) return;
  ajustesHandlersReady = true;

  document.getElementById("btn-trocar-empresa").addEventListener("click", () => {
    showCompanyPicker(currentCompanies, accessToken, currentEmail);
  });

  document.getElementById("btn-ir-sistema").addEventListener("click", showSistemaScreen);

  document.getElementById("btn-refresh-dashboard").addEventListener("click", refreshAllData);

  setupEditarPerfilForm();
  setupCriarSenhaAjustes();
  setupNotificacoesAjustes();
}

const LAST_SESSION_KEY = "financegold_last_session";
const REMEMBERED_COMPANY_KEY = "financegold_company";

// Per-tab (sessionStorage): a page reload should land back in the company the
// user was working in, not on the company picker again. Cleared on logout.
function rememberCompany(spreadsheetId) {
  try {
    sessionStorage.setItem(REMEMBERED_COMPANY_KEY, spreadsheetId);
  } catch (err) {
    // convenience only
  }
}

function loadRememberedCompany() {
  try {
    return sessionStorage.getItem(REMEMBERED_COMPANY_KEY);
  } catch (err) {
    return null;
  }
}

// Called only on an explicit sign-out (never on an expired session, which keeps
// the place and the offline data so the person resumes after signing in again).
function forgetSessionPlace() {
  clearCachedBusinessData();
  try {
    sessionStorage.removeItem(REMEMBERED_COMPANY_KEY);
    sessionStorage.removeItem(LAST_VIEW_KEY);
  } catch (err) {
    // convenience only
  }
}

function saveLastSession(info) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(info));
  } catch (err) {
    // best effort — only affects the offline-resume fallback, not core function
  }
}

function loadLastSession() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// Reached only when a sessionStorage token exists but we're offline, so the
// normal scope/identity checks (both need network) can't run. Trusts the
// last successful login's identity instead of re-verifying it.
async function enterOfflineFromLastSession(token) {
  const last = loadLastSession();
  if (!last) {
    showLogin();
    loginStatus.textContent =
      "Sem internet, e nenhuma sessão anterior salva neste navegador. Conecte-se para entrar pela primeira vez.";
    return;
  }
  currentEmail = last.email;
  currentCompanies = lookupTenants(last.email) || [
    { empresa: last.empresa, spreadsheetId: last.spreadsheetId, sheetName: last.sheetName },
  ];
  CONFIG.SPREADSHEET_ID = last.spreadsheetId;
  CONFIG.SHEET_NAME = last.sheetName;
  setActiveCompanyLabel(last.empresa);
  aplicarSegmento(last.segmento);
  await startApp(token, last.nome, last.perfil, last.linha);
}

async function startApp(token, nome, perfil, linha) {
  currentUserRole = perfil;
  currentUserLinha = linha;
  setUserIdentity(nome);
  saveLastSession({
    email: currentEmail,
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    sheetName: CONFIG.SHEET_NAME,
    segmento: segmentoAtual,
    empresa: sidebarEmpresa.textContent,
    nome,
    perfil,
    linha,
  });
  // Set up and pick the right screen while the shell is still hidden, so the
  // dashboard never flashes before jumping to the screen the person was on.
  setupNavigation();
  applyRoleVisibility(perfil);
  setupAjustesHandlers();
  restoreLastViewOnce();
  showApp();

  document.getElementById("ajustes-conta-nome").textContent = nome;
  document.getElementById("ajustes-conta-email").textContent = currentEmail || "";
  document.getElementById("ajustes-conta-email-oculto").value = currentEmail || "";
  document.getElementById("ajustes-conta-empresa").textContent = sidebarEmpresa.textContent;
  document.getElementById("ajustes-trocar-empresa-card").hidden = currentCompanies.length <= 1;
  prepararCartaoDeSenha();
  // Offered to anyone who skipped "login próprio" at sign-in (see js/completar-cadastro.js).
  document.getElementById("ajustes-criar-senha-card").hidden =
    !(CONFIG.GATEWAY_URL && tipoDeSessao() === "google" && !currentTemSenhaAtiva);
  document.getElementById("ajustes-usuarios-section").hidden = !isMaster(perfil);
  // Creating companies and editing the lists need the gateway (direct mode has
  // no registry); the company's Master edits lists, only system admins create companies.
  const gatewayMode = Boolean(CONFIG.GATEWAY_URL);
  document.getElementById("ajustes-listas-section").hidden = true; // shown after Configuração is read (standard list tabs only)
  document.getElementById("ajustes-sistema-card").hidden = !(gatewayMode && currentIsSuperAdmin);

  statusMessage.textContent = "Carregando dados...";

  // Which tab plays which role for this company (Configuração), before any data is read.
  resetarAbasDaEmpresa();
  try {
    await carregarConfiguracaoAbas(token);
  } catch (err) {
    if (err.sessionExpired) return;
    console.error(err);
  }

  const [lancResult, lookupsResult, estoqueResult, fornecedoresResult, contasPagarResult, contasReceberResult, extratoResult] = await Promise.allSettled([
    fetchWithOfflineFallback(() => fetchLancamentos(token), "lancamentos", serializeLancamentos, deserializeLancamentos),
    fetchWithOfflineFallback(() => fetchAllLookups(token), "lookups", null, null),
    fetchWithOfflineFallback(() => fetchEstoque(token), "estoque", serializeEstoque, deserializeEstoque),
    fetchWithOfflineFallback(() => fetchFornecedores(token), "fornecedores", null, null),
    fetchWithOfflineFallback(() => fetchContas("pagar", token), "contas-pagar", null, null),
    fetchWithOfflineFallback(() => fetchContas("receber", token), "contas-receber", null, null),
    fetchWithOfflineFallback(() => fetchExtrato(token), "extrato", serializeExtrato, deserializeExtrato),
  ]);

  const errors = [];
  let anyFromCache = false;

  if (lancResult.status === "fulfilled") {
    initDashboard(lancResult.value.data);
    initLancamentoLista(lancResult.value.data);
    setupRelatorio();
    if (lancResult.value.fromCache) anyFromCache = true;
  } else {
    console.error(lancResult.reason);
    errors.push(`Lançamentos: ${lancResult.reason.message}`);
  }

  if (lookupsResult.status === "fulfilled") {
    populateLookupSelects(lookupsResult.value.data);
    setupLancamentoForm();
    populateEstoqueFormSelects(lookupsResult.value.data);
    if (lookupsResult.value.fromCache) anyFromCache = true;
  } else {
    console.error(lookupsResult.reason);
    errors.push(`Listas de apoio: ${lookupsResult.reason.message}`);
  }

  if (estoqueResult.status === "fulfilled" && lookupsResult.status === "fulfilled") {
    setupEstoqueForm();
    initEstoqueList(estoqueResult.value.data, lookupsResult.value.data);
    if (estoqueResult.value.fromCache) anyFromCache = true;
  } else if (estoqueResult.status === "rejected") {
    console.error(estoqueResult.reason);
    errors.push(`Estoque: ${estoqueResult.reason.message}`);
  }

  if (fornecedoresResult.status === "fulfilled") {
    setupFornecedoresForm();
    initFornecedoresList(fornecedoresResult.value.data);
    if (fornecedoresResult.value.fromCache) anyFromCache = true;
  } else {
    console.error(fornecedoresResult.reason);
    errors.push(`Fornecedores: ${fornecedoresResult.reason.message}`);
  }

  if (contasPagarResult.status === "fulfilled" && lookupsResult.status === "fulfilled") {
    setupContaForm("pagar");
    initContasList("pagar", contasPagarResult.value.data, lookupsResult.value.data);
    if (contasPagarResult.value.fromCache) anyFromCache = true;
  } else if (contasPagarResult.status === "rejected") {
    console.error(contasPagarResult.reason);
    errors.push(`Contas a Pagar: ${contasPagarResult.reason.message}`);
  }

  if (contasReceberResult.status === "fulfilled" && lookupsResult.status === "fulfilled") {
    setupContaForm("receber");
    initContasList("receber", contasReceberResult.value.data, lookupsResult.value.data);
    if (contasReceberResult.value.fromCache) anyFromCache = true;
  } else if (contasReceberResult.status === "rejected") {
    console.error(contasReceberResult.reason);
    errors.push(`Contas a Receber: ${contasReceberResult.reason.message}`);
  }

  if (extratoResult.status === "fulfilled" && lookupsResult.status === "fulfilled") {
    initExtratoUi(extratoResult.value.data, lookupsResult.value.data);
    if (extratoResult.value.fromCache) anyFromCache = true;
  } else if (extratoResult.status === "rejected") {
    console.error(extratoResult.reason);
    errors.push(`Extrato Bancário: ${extratoResult.reason.message}`);
  }

  // Dashboard's own small "Contas a Pagar"/"Contas a Receber"/"Valor em
  // estoque" numbers — shown even if only some of the three loaded (the
  // others just read 0).
  renderContasResumoDashboard(
    contasPagarResult.status === "fulfilled" ? contasPagarResult.value.data : [],
    contasReceberResult.status === "fulfilled" ? contasReceberResult.value.data : [],
    estoqueResult.status === "fulfilled" ? estoqueResult.value.data : []
  );

  // Avisos de vencimento (gateway mode only — sending e-mail needs Apps
  // Script). Fire-and-forget: checked once per login for Editor/Master (the
  // server re-checks the role too), deduped server-side by each conta's own
  // "Avisado em" column, so logging in again the same day never double-mails.
  if (CONFIG.GATEWAY_URL && canEdit(perfil)) {
    gatewayCall("verificarLembretes", { spreadsheetId: CONFIG.SPREADSHEET_ID }, token).catch((err) => {
      console.error("Avisos de vencimento:", err);
    });
  }

  // Inputs for the sheet's own extra columns, from the layouts just detected.
  const esqLanc = obterEsquema("lancamentos");
  const esqEst = obterEsquema("estoque");
  montarCamposExtras("lancamento-extras-grid", esqLanc ? esqLanc.extras : []);
  montarCamposExtras("estoque-extras-grid", esqEst ? esqEst.extras : []);

  if (gatewayMode && isMaster(perfil)) {
    // Editing the lists from here assumes the standard list tabs; a company whose lists were connected from other tabs edits them in its spreadsheet.
    const listasPadrao = !temListasConectadas();
    document.getElementById("ajustes-listas-section").hidden = !listasPadrao;
    if (listasPadrao) initListasAdmin();
  }
  if (isMaster(perfil)) initConectar();
  if (isMaster(perfil)) initFiscalConfig();

  if (isMaster(perfil)) {
    try {
      initUsuariosAdmin(await fetchAllUsuarios(token));
    } catch (err) {
      console.error(err);
      if (!isNetworkError(err)) errors.push(`Usuários: ${err.message}`);
    }
  }

  updateOfflineBanner();
  if (!anyFromCache && getQueue().length > 0) {
    flushQueue();
  }

  if (errors.length > 0) {
    statusMessage.textContent = `Carregado com erros — ${errors.join(" | ")}`;
  } else if (anyFromCache) {
    // Offline is deliberately silent: just keep showing the cached data.
    statusMessage.textContent = "";
  } else {
    const ignoradas = ultimoResumoLeitura.lancamentos + ultimoResumoLeitura.estoque;
    statusMessage.textContent =
      `${lancResult.value.data.length} lançamentos e ${estoqueResult.value.data.length} ${vocab("carregados")}.` +
      (ignoradas > 0 ? ` ${ignoradas} linha(s) da planilha não puderam ser lidas (sem data ou sem produto) e foram ignoradas.` : "");
  }
}

// Companies for a signed-in email = the ones pinned to it in js/tenants.js
// (the owner's own routing) plus every other known company whose "Usuários" tab
// lists it. The second half is what makes "Master adds someone in Ajustes"
// enough on its own. Drive sharing is still the real gate: without access to a
// spreadsheet the Sheets API refuses the read and that company is skipped.
function companiesFromMe(me) {
  return me.companies.concat(me.bootstrap).map((c) => ({
    empresa: c.empresa,
    spreadsheetId: c.spreadsheetId,
    sheetName: c.sheetName,
    segmento: segmentoValido(c.segmento),
  }));
}

// Re-reads the support lists (lojas, contas...) after Ajustes → Listas de apoio
// changed them, so the dropdowns in the forms show the new items right away.
async function refreshLookupsOnly() {
  const lookups = await fetchAllLookups(accessToken);
  populateLookupSelects(lookups);
  populateEstoqueFormSelects(lookups);
  estoqueLookups = lookups;
}

async function resolveCompaniesForEmail(email, token) {
  if (CONFIG.GATEWAY_URL) {
    // The gateway is the source of truth: it returns the companies whose
    // Usuários tab lists this email, plus any it may set up for the first time.
    const me = await gatewayCall("me", {}, token);
    currentIsSuperAdmin = Boolean(me.superAdmin);
    currentPedido = me.pedido || null;
    currentPedidosPendentes = me.pedidosPendentes || 0;
    currentTemSenhaAtiva = Boolean(me.temSenhaAtiva);
    return companiesFromMe(me);
  }
  const found = (lookupTenants(email) || []).slice();
  const knownIds = new Set(found.map((c) => c.spreadsheetId));
  const candidates = allKnownCompanies().filter((c) => !knownIds.has(c.spreadsheetId));

  const results = await Promise.allSettled(
    candidates.map((c) => isEmailListedInCompany(c.spreadsheetId, email, token))
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) found.push(candidates[index]);
  });
  return found;
}

// A resumed sessionStorage token still needs an online round-trip to verify
// scopes and identity — without this fallback, reloading the page while
// offline (e.g. during a power/internet outage) would hang forever on
// "Verificando conta..." with no way to reach the cached data underneath,
// defeating the entire point of the offline cache.
async function handleSignedIn(token) {
  sessionExpiredHandled = false;
  loginStatus.textContent = "Verificando conta...";

  // A session of the e-mail + password login: the server already knows who it is
  // (there is no Google token to check).
  if (tipoDeSessao() === "senha") return seguirComConta(token, emailDaSessao());

  let grantedScopes;
  try {
    grantedScopes = await escoposDoToken(token);
  } catch (err) {
    if (isNetworkError(err)) return enterOfflineFromLastSession(token);
    console.error(err);
    // Google not answering is not a bad token: keep the session, a reload tries again.
    showLogin();
    loginStatus.textContent = "Não foi possível verificar sua conta Google agora. Atualize a página para tentar de novo.";
    return;
  }

  if (!grantedScopes || !hasAllScopes(grantedScopes, CONFIG.SCOPES)) {
    clearTokenSession();
    showLogin();
    loginStatus.textContent =
      "Sua conta não concedeu todas as permissões necessárias (acesso ao Google Sheets). Clique em \"Entrar com Google\" novamente e aceite todas as permissões pedidas.";
    return;
  }

  let email;
  try {
    email = await emailDoToken(token);
  } catch (err) {
    if (isNetworkError(err)) return enterOfflineFromLastSession(token);
    console.error(err);
    if (err.status === 401 || err.status === 403) clearTokenSession(); // the token itself was refused
    showLogin();
    loginStatus.textContent = "Não foi possível verificar sua conta Google. Atualize a página ou entre de novo.";
    return;
  }

  return seguirComConta(token, email);
}

// From here on it does not matter HOW the person proved who they are (Google or
// e-mail + password): find their companies and route them.
async function seguirComConta(token, email) {
  let companies;
  try {
    companies = await tentarVariasVezes(() => resolveCompaniesForEmail(email, token));
  } catch (err) {
    if (isNetworkError(err)) return enterOfflineFromLastSession(token);
    if (err.sessionExpired) return; // handleSessionExpired already showed the login screen
    console.error(err);
    // The session is still good: do not sign the person out because the server hiccuped.
    showLogin();
    loginStatus.textContent = `Não foi possível conectar ao servidor agora. Atualize a página para tentar de novo. (${err.message})`;
    return;
  }
  // The system administrator (developer) lands in the Painel do sistema, never
  // in a company by default; if they also belong to companies they choose.
  if (CONFIG.GATEWAY_URL && currentIsSuperAdmin) {
    currentEmail = email;
    currentCompanies = companies;
    if (companies.length === 0 || loadRememberedCompany() === SISTEMA_KEY) {
      showSistemaScreen();
    } else {
      showCompanyPicker(companies, token, email);
    }
    return;
  }

  if (companies.length === 0) {
    currentEmail = email;
    if (CONFIG.GATEWAY_URL) {
      // Keep the session: the person can ask for access from here.
      showSolicitarAcessoScreen(email, currentPedido);
      return;
    }
    clearTokenSession();
    showLogin();
    loginStatus.textContent = `O e-mail ${email} ainda não tem acesso a nenhuma empresa. Peça a quem administra para cadastrar este e-mail em Ajustes.`;
    return;
  }

  currentEmail = email;
  currentCompanies = companies;

  const remembered = loadRememberedCompany();
  const rememberedTenant = companies.length > 1 && remembered
    ? companies.find((c) => c.spreadsheetId === remembered)
    : null;

  if (companies.length === 1) {
    await resolveProfileAndEnter(companies[0], token, email);
  } else if (rememberedTenant) {
    await resolveProfileAndEnter(rememberedTenant, token, email);
  } else {
    showCompanyPicker(companies, token, email);
  }
}

// A successful e-mail + password login: keep the session for this tab and continue
// exactly as after a Google login (js/login-senha.js calls this). "lembrar" also
// keeps it in localStorage, surviving a closed tab/app, up to the longer
// expiry the server already issued (see acaoPwLogin_ in Code.gs) — Google
// logins never offer this, see the note on saveTokenToSession.
function entrarComSenha(resposta, lembrar) {
  saveSenhaSession(resposta.token, resposta.expiraEm, resposta.email, lembrar);
  handleSignedIn(resposta.token);
}

const authReady = initAuth(handleSignedIn, mostrarErroDeLogin).catch((err) => {
  console.error(err);
  loginStatus.textContent = "Erro ao carregar o login do Google. Recarregue a página.";
});

loginButton.addEventListener("click", async () => {
  loginStatus.textContent = "";
  // Open Google's window in the very same click: browsers only allow a pop-up made
  // directly by a tap/click, and waiting first (await) could get it blocked, which
  // looked like "it went back and I had to click twice".
  if (tokenClient) {
    requestAccessToken();
    return;
  }
  loginButton.disabled = true;
  loginStatus.textContent = "Preparando o login do Google...";
  try {
    await authReady;
    loginStatus.textContent = "";
    requestAccessToken();
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", () => {
  forgetSessionPlace();
  signOut();
  showLogin();
});

pickerLogoutButton.addEventListener("click", () => {
  forgetSessionPlace();
  signOut();
  showLogin();
});

document.getElementById("btn-solicitar-sair").addEventListener("click", () => {
  forgetSessionPlace();
  signOut();
  showLogin();
});

acessoNegadoLogoutButton.addEventListener("click", () => {
  forgetSessionPlace();
  signOut();
  showLogin();
});

// Resume a session already active in this tab (survives reloads, not tab close).
(async () => {
  const existingToken = loadValidTokenFromSession();
  if (existingToken) {
    await handleSignedIn(existingToken);
  }
})();
