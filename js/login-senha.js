// Screens and actions of the e-mail + password login: signing in, creating an
// access (e-mail code, then the administrator's approval), "forgot password",
// changing the password from Ajustes, and the administrator's list in the
// Painel do sistema. The cryptography and the strength rules are in js/senha.js;
// the checks that really protect the data are in apps-script/Code.gs.

let loginSenhaPronto = false;
let cadastroChave = null;
let cadastroDados = null;
let esqueciEmail = "";
let reenvioTimer = null;
let loginsAdminPendentes = [];
let loginsConfirmando = null;

function porId(id) {
  return document.getElementById(id);
}

// A message under a form; failures are red.
function dizer(elId, texto, erro) {
  const el = porId(elId);
  if (!el) return;
  el.textContent = texto || "";
  el.classList.toggle("status-erro", Boolean(erro));
}

function emailParecido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor) && valor.length <= 120;
}

// The button that shows / hides the typed password (fixed icon drawn with DOM calls).
function criarBotaoOlho(input) {
  const ns = "http://www.w3.org/2000/svg";
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "btn-ver-senha";
  botao.title = "Mostrar senha";
  botao.setAttribute("aria-label", "Mostrar senha");
  botao.setAttribute("aria-pressed", "false");
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const corpo = document.createElementNS(ns, "path");
  corpo.setAttribute("d", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z");
  const pupila = document.createElementNS(ns, "circle");
  pupila.setAttribute("cx", "12");
  pupila.setAttribute("cy", "12");
  pupila.setAttribute("r", "3");
  const risco = document.createElementNS(ns, "path");
  risco.setAttribute("class", "olho-risco");
  risco.setAttribute("d", "M4 4l16 16");
  svg.appendChild(corpo);
  svg.appendChild(pupila);
  svg.appendChild(risco);
  botao.appendChild(svg);
  botao.addEventListener("click", () => {
    const vai = input.type === "password";
    input.type = vai ? "text" : "password";
    botao.classList.toggle("aberto", vai);
    botao.setAttribute("aria-pressed", vai ? "true" : "false");
    botao.setAttribute("aria-label", vai ? "Ocultar senha" : "Mostrar senha");
    botao.title = vai ? "Ocultar senha" : "Mostrar senha";
    input.focus();
  });
  return botao;
}

function montarCamposDeSenha() {
  document.querySelectorAll(".campo-senha").forEach((campo) => {
    if (campo.querySelector(".btn-ver-senha")) return;
    const input = campo.querySelector("input");
    if (input) campo.appendChild(criarBotaoOlho(input));
  });
}

// Every password box goes back to hidden and empty when its screen is left.
function limparCamposDeSenha(raiz) {
  (raiz || document).querySelectorAll(".campo-senha input").forEach((input) => {
    input.value = "";
    input.type = "password";
    const botao = input.parentElement.querySelector(".btn-ver-senha");
    if (botao) {
      botao.classList.remove("aberto");
      botao.setAttribute("aria-pressed", "false");
      botao.setAttribute("aria-label", "Mostrar senha");
    }
  });
  (raiz || document).querySelectorAll(".forca-senha").forEach((f) => atualizarForca(f));
}

function atualizarForca(caixa) {
  const input = porId(caixa.dataset.forcaDe);
  const email = caixa.dataset.emailDe && porId(caixa.dataset.emailDe) ? porId(caixa.dataset.emailDe).value : "";
  const r = avaliarSenha(input ? input.value : "", email);
  caixa.dataset.nivel = String(r.nivel);
  caixa.querySelector(".forca-texto").textContent = r.rotulo ? (r.dica ? `${r.rotulo}. ${r.dica}` : r.rotulo) : "";
  return r;
}

function ligarMedidoresDeForca() {
  document.querySelectorAll(".forca-senha").forEach((caixa) => {
    const input = porId(caixa.dataset.forcaDe);
    if (!input) return;
    input.addEventListener("input", () => atualizarForca(caixa));
    const emailInput = caixa.dataset.emailDe ? porId(caixa.dataset.emailDe) : null;
    if (emailInput) emailInput.addEventListener("input", () => atualizarForca(caixa));
  });
}

function mostrarPasso(prefixo, passo) {
  ["dados", "codigo", "email", "nova", "pronto"].forEach((p) => {
    const bloco = porId(`${prefixo}-passo-${p}`);
    if (bloco) bloco.hidden = p !== passo;
  });
}

function mostrarTelaDeSenha(id) {
  hideAllScreens();
  porId(id).hidden = false;
}

// ---- sign in ---------------------------------------------------------------

async function enviarLoginSenha(evento) {
  evento.preventDefault();
  const identificador = porId("login-email").value.trim();
  const senha = porId("login-senha").value;
  const lembrar = porId("login-lembrar").checked;
  if (!identificador || !senha) return dizer("login-senha-status", "Informe o e-mail (ou login) e a senha.", true);
  if (!emailParecido(identificador) && !loginParecido(identificador)) return dizer("login-senha-status", "Informe um e-mail ou um login válidos.", true);
  const botao = porId("btn-entrar-senha");
  botao.disabled = true;
  dizer("login-senha-status", "Verificando...", false);
  try {
    // The password key is derived with the e-mail as salt (js/senha.js), so a
    // typed "login" (username) must first be resolved to the real e-mail —
    // the server never sees the password itself, only the derived key.
    let email = identificador;
    if (!emailParecido(identificador)) {
      const achado = await gatewayCall("pwBuscarEmailPorLogin", { login: identificador }, null);
      email = achado.email;
    }
    const chave = await derivarChaveDeSenha(senha, email);
    const resposta = await gatewayCall("pwLogin", { email, chave, lembrar }, null);
    porId("login-senha").value = "";
    dizer("login-senha-status", "", false);
    entrarComSenha(resposta, lembrar);
  } catch (err) {
    console.error(err);
    dizer("login-senha-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

// ---- create an access -------------------------------------------------------

function abrirCadastroSenha() {
  ["cs-nome", "cs-email", "cs-login", "cs-funcao", "cs-empresa"].forEach((id) => (porId(id).value = ""));
  limparCamposDeSenha(porId("senha-cadastro-screen"));
  porId("cs-email").value = porId("login-email").value.trim();
  cadastroChave = null;
  cadastroDados = null;
  dizer("cadastro-senha-status", "", false);
  mostrarPasso("cadastro", "dados");
  mostrarTelaDeSenha("senha-cadastro-screen");
  porId("cs-nome").focus();
}

function contagemDoReenvio(segundos) {
  const botao = porId("btn-reenviar-codigo");
  clearInterval(reenvioTimer);
  let restante = segundos;
  const pintar = () => {
    botao.disabled = restante > 0;
    botao.textContent = restante > 0 ? `Enviar outro código (${restante}s)` : "Enviar outro código";
  };
  pintar();
  reenvioTimer = setInterval(() => {
    restante -= 1;
    pintar();
    if (restante <= 0) clearInterval(reenvioTimer);
  }, 1000);
}

async function enviarCadastro(evento) {
  evento.preventDefault();
  const nome = porId("cs-nome").value.trim();
  const email = porId("cs-email").value.trim();
  const login = porId("cs-login").value.trim();
  const funcao = porId("cs-funcao").value.trim();
  const empresa = porId("cs-empresa").value.trim();
  const senha = porId("cs-senha").value;
  const confirmar = porId("cs-confirmar").value;
  if (!nome) return dizer("cadastro-senha-status", "Informe o seu nome.", true);
  if (!emailParecido(email)) return dizer("cadastro-senha-status", "Informe um e-mail válido.", true);
  if (!loginParecido(login)) return dizer("cadastro-senha-status", "Escolha um login com 3 a 30 letras, números, ponto, hífen ou underline.", true);
  if (!funcao) return dizer("cadastro-senha-status", "Informe a sua função na empresa.", true);
  const forca = avaliarSenha(senha, email);
  if (!forca.ok) return dizer("cadastro-senha-status", forca.dica || "Escolha uma senha mais forte.", true);
  if (senha !== confirmar) return dizer("cadastro-senha-status", "As duas senhas não são iguais.", true);
  const botao = porId("btn-cadastrar-senha");
  botao.disabled = true;
  dizer("cadastro-senha-status", "Enviando...", false);
  try {
    cadastroChave = await derivarChaveDeSenha(senha, email);
    cadastroDados = { nome, email, login, funcao, empresa, mensagem: "" };
    await gatewayCall("pwRegister", Object.assign({ chave: cadastroChave }, cadastroDados), null);
    porId("cadastro-codigo-lede").textContent = `Enviamos um código de 6 números para ${email}. Digite-o abaixo. Ele vale por 15 minutos.`;
    porId("cs-codigo").value = "";
    dizer("cadastro-codigo-status", "", false);
    limparCamposDeSenha(porId("senha-cadastro-screen"));
    mostrarPasso("cadastro", "codigo");
    contagemDoReenvio(60);
    porId("cs-codigo").focus();
  } catch (err) {
    console.error(err);
    cadastroChave = null;
    dizer("cadastro-senha-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

async function confirmarCodigoDoCadastro(evento) {
  evento.preventDefault();
  const codigo = porId("cs-codigo").value.replace(/\D/g, "");
  if (codigo.length !== 6) return dizer("cadastro-codigo-status", "Digite os 6 números do código.", true);
  const botao = porId("btn-confirmar-codigo");
  botao.disabled = true;
  dizer("cadastro-codigo-status", "Confirmando...", false);
  try {
    const resposta = await gatewayCall("pwConfirmar", { email: cadastroDados.email, codigo }, null);
    clearInterval(reenvioTimer);
    cadastroChave = null;
    // A Master may have already authorized this e-mail in some company: then
    // there is nothing left to wait for (see autorizadoEmAlgumaEmpresa_).
    const jaAtivo = resposta.situacao === "Ativo";
    porId("cadastro-pronto-titulo").textContent = jaAtivo ? "Acesso liberado" : "Cadastro recebido";
    porId("cadastro-pronto-lede").textContent = jaAtivo
      ? "Seu e-mail já era autorizado por uma empresa, então o seu login e senha já estão liberados. Entre com o seu e-mail (ou login) e a senha que você criou."
      : "Seu e-mail foi confirmado. Agora o administrador do sistema precisa liberar o seu acesso. Você receberá um e-mail assim que isso acontecer e poderá entrar com o seu e-mail (ou login) e a senha que criou.";
    mostrarPasso("cadastro", "pronto");
  } catch (err) {
    console.error(err);
    dizer("cadastro-codigo-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

async function reenviarCodigoDoCadastro() {
  if (!cadastroChave || !cadastroDados) return;
  dizer("cadastro-codigo-status", "Enviando...", false);
  try {
    await gatewayCall("pwRegister", Object.assign({ chave: cadastroChave }, cadastroDados), null);
    dizer("cadastro-codigo-status", "Enviamos um novo código.", false);
    contagemDoReenvio(60);
  } catch (err) {
    console.error(err);
    dizer("cadastro-codigo-status", mensagemDoErro(err), true);
  }
}

// ---- forgot password --------------------------------------------------------

function abrirEsqueciSenha() {
  porId("es-email").value = porId("login-email").value.trim();
  porId("es-codigo").value = "";
  limparCamposDeSenha(porId("senha-esqueci-screen"));
  dizer("esqueci-email-status", "", false);
  dizer("esqueci-nova-status", "", false);
  mostrarPasso("esqueci", "email");
  mostrarTelaDeSenha("senha-esqueci-screen");
  porId("es-email").focus();
}

async function enviarEsqueciEmail(evento) {
  evento.preventDefault();
  const email = porId("es-email").value.trim();
  if (!emailParecido(email)) return dizer("esqueci-email-status", "Informe um e-mail válido.", true);
  const botao = porId("btn-esqueci-enviar");
  botao.disabled = true;
  dizer("esqueci-email-status", "Enviando...", false);
  try {
    await gatewayCall("pwEsqueci", { email }, null);
    esqueciEmail = email;
    porId("esqueci-nova-lede").textContent = `Se o e-mail ${email} tiver um acesso, enviamos um código de 6 números para ele. Digite o código e escolha a nova senha.`;
    mostrarPasso("esqueci", "nova");
    porId("es-codigo").focus();
  } catch (err) {
    console.error(err);
    dizer("esqueci-email-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

async function salvarNovaSenhaDoEsqueci(evento) {
  evento.preventDefault();
  const codigo = porId("es-codigo").value.replace(/\D/g, "");
  const senha = porId("es-senha").value;
  const confirmar = porId("es-confirmar").value;
  if (codigo.length !== 6) return dizer("esqueci-nova-status", "Digite os 6 números do código.", true);
  const forca = avaliarSenha(senha, esqueciEmail);
  if (!forca.ok) return dizer("esqueci-nova-status", forca.dica || "Escolha uma senha mais forte.", true);
  if (senha !== confirmar) return dizer("esqueci-nova-status", "As duas senhas não são iguais.", true);
  const botao = porId("btn-esqueci-salvar");
  botao.disabled = true;
  dizer("esqueci-nova-status", "Salvando...", false);
  try {
    const chave = await derivarChaveDeSenha(senha, esqueciEmail);
    await gatewayCall("pwRedefinir", { email: esqueciEmail, codigo, chave }, null);
    limparCamposDeSenha(porId("senha-esqueci-screen"));
    mostrarPasso("esqueci", "pronto");
  } catch (err) {
    console.error(err);
    dizer("esqueci-nova-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

function voltarParaAEntrada(email) {
  clearInterval(reenvioTimer);
  cadastroChave = null;
  limparCamposDeSenha(document);
  showLogin();
  if (email) porId("login-email").value = email;
}

// ---- change password (Ajustes) ----------------------------------------------

async function enviarTrocaDeSenha(evento) {
  evento.preventDefault();
  const atual = porId("trocar-senha-atual").value;
  const nova = porId("trocar-senha-nova").value;
  const confirmar = porId("trocar-senha-confirmar").value;
  const email = currentEmail || emailDaSessao();
  if (!atual) return dizer("trocar-senha-status", "Informe a senha atual.", true);
  const forca = avaliarSenha(nova, email);
  if (!forca.ok) return dizer("trocar-senha-status", forca.dica || "Escolha uma senha mais forte.", true);
  if (nova !== confirmar) return dizer("trocar-senha-status", "As duas senhas novas não são iguais.", true);
  if (nova === atual) return dizer("trocar-senha-status", "A nova senha precisa ser diferente da atual.", true);
  const botao = porId("btn-trocar-senha");
  botao.disabled = true;
  dizer("trocar-senha-status", "Salvando...", false);
  try {
    // Keep whatever "manter conectado" state this session already had — a
    // password change must not silently drop someone out of a remembered
    // device, nor remember a device that never asked for it.
    const lembrar = Boolean(loadRememberedSenhaSession());
    const chaveAtual = await derivarChaveDeSenha(atual, email);
    const chaveNova = await derivarChaveDeSenha(nova, email);
    const resposta = await gatewayCall("pwTrocarSenha", { atual: chaveAtual, nova: chaveNova, lembrar }, accessToken);
    // The old session ended with the change; the one returned keeps this person signed in.
    saveSenhaSession(resposta.token, resposta.expiraEm, emailDaSessao(), lembrar);
    limparCamposDeSenha(porId("trocar-senha-form"));
    dizer("trocar-senha-status", "Senha alterada. Os outros aparelhos foram desconectados.", false);
  } catch (err) {
    console.error(err);
    dizer("trocar-senha-status", mensagemDoErro(err), true);
  } finally {
    botao.disabled = false;
  }
}

// Shown only for people who signed in with a password (a Google account has none to change here).
function prepararCartaoDeSenha() {
  const cartao = porId("ajustes-senha-card");
  if (!cartao) return;
  const ehSenha = tipoDeSessao() === "senha";
  cartao.hidden = !ehSenha;
  porId("trocar-senha-usuario").value = ehSenha ? emailDaSessao() : "";
  if (ehSenha) {
    limparCamposDeSenha(porId("trocar-senha-form"));
    dizer("trocar-senha-status", "", false);
  }
}

// ---- administrator: logins with password (Painel do sistema) ----------------

function dataCurta(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR");
}

async function decidirLogin(email, acao, nota) {
  await gatewayCall("pwDecidir", { email, acao, nota: nota || "" }, accessToken);
  loginsConfirmando = null;
  await carregarLoginsSistema();
}

function botaoDeLogin(rotulo, acao, email, classe, confirmar) {
  const chave = `${acao}:${email}`;
  if (confirmar && loginsConfirmando === chave) {
    const grupo = document.createDocumentFragment();
    grupo.appendChild(
      makeAdminButton("Confirmar", async () => {
        try {
          await decidirLogin(email, acao, "");
          dizer("logins-status", acao === "bloquear" ? "Acesso bloqueado. As sessões abertas foram encerradas." : "Cadastro recusado. A pessoa foi avisada por e-mail.", false);
        } catch (err) {
          console.error(err);
          dizer("logins-status", `Erro: ${mensagemDoErro(err)}`, true);
        }
      }, "usuario-action-danger")
    );
    grupo.appendChild(makeAdminButton("Cancelar", () => { loginsConfirmando = null; renderLoginsSistema(); }));
    return grupo;
  }
  return makeAdminButton(rotulo, async () => {
    if (confirmar) {
      loginsConfirmando = chave;
      renderLoginsSistema();
      return;
    }
    try {
      await decidirLogin(email, acao, "");
      dizer("logins-status", acao === "aprovar" ? "Acesso liberado. A pessoa foi avisada por e-mail." : "Feito.", false);
    } catch (err) {
      console.error(err);
      dizer("logins-status", `Erro: ${mensagemDoErro(err)}`, true);
    }
  }, classe);
}

function renderLoginsSistema() {
  const pend = porId("logins-pendentes");
  const ativos = porId("logins-ativos");
  const outros = porId("logins-outros");
  if (!pend) return;
  pend.innerHTML = "";
  ativos.innerHTML = "";
  outros.innerHTML = "";

  if (loginsAdminPendentes.pendentes.length === 0) {
    const p = document.createElement("p");
    p.className = "lista-vazia";
    p.textContent = "Nenhum login aguardando aprovação.";
    pend.appendChild(p);
  }
  loginsAdminPendentes.pendentes.forEach((l) => {
    const card = document.createElement("div");
    card.className = "pedido-card";
    const titulo = document.createElement("div");
    titulo.className = "pedido-titulo";
    titulo.textContent = `${l.nome} — ${l.email}`;
    card.appendChild(titulo);
    const meta = document.createElement("div");
    meta.className = "pedido-meta";
    meta.textContent = [l.funcao, l.empresa || "empresa não informada", "e-mail confirmado", dataCurta(l.criadoEm)].filter(Boolean).join(" · ");
    card.appendChild(meta);
    const acoes = document.createElement("div");
    acoes.className = "pedido-acoes";
    acoes.appendChild(botaoDeLogin("Aprovar", "aprovar", l.email, "usuario-action-primary", false));
    acoes.appendChild(botaoDeLogin("Recusar", "recusar", l.email, "usuario-action-danger-soft", true));
    card.appendChild(acoes);
    pend.appendChild(card);
  });

  const linha = (l, botoes) => {
    const li = document.createElement("li");
    const nome = document.createElement("div");
    nome.className = "pedido-titulo";
    nome.textContent = `${l.nome} — ${l.email}`;
    li.appendChild(nome);
    const meta = document.createElement("div");
    meta.className = "pedido-meta";
    meta.textContent = [l.situacao, l.funcao, l.ultimoAcesso ? `último acesso ${dataCurta(l.ultimoAcesso)}` : "nunca entrou"].filter(Boolean).join(" · ");
    li.appendChild(meta);
    const acoes = document.createElement("div");
    acoes.className = "login-acoes";
    botoes.forEach((b) => acoes.appendChild(b));
    li.appendChild(acoes);
    return li;
  };
  if (loginsAdminPendentes.ativos.length === 0) {
    const li = document.createElement("li");
    li.className = "lista-vazia";
    li.textContent = "Nenhum acesso ativo ainda.";
    ativos.appendChild(li);
  }
  loginsAdminPendentes.ativos.forEach((l) => ativos.appendChild(linha(l, [botaoDeLogin("Bloquear", "bloquear", l.email, "usuario-action-danger-soft", true)])));
  if (loginsAdminPendentes.outros.length === 0) {
    const li = document.createElement("li");
    li.className = "lista-vazia";
    li.textContent = "Nenhum.";
    outros.appendChild(li);
  }
  loginsAdminPendentes.outros.forEach((l) => outros.appendChild(linha(l, [botaoDeLogin("Reativar", "reativar", l.email, "usuario-action-primary", false)])));
  porId("sistema-logins-contador").textContent = loginsAdminPendentes.pendentes.length ? `(${loginsAdminPendentes.pendentes.length})` : "";
}

async function carregarLoginsSistema() {
  try {
    const dados = await gatewayCall("pwListar", {}, accessToken);
    loginsAdminPendentes = { pendentes: dados.pendentes || [], ativos: dados.ativos || [], outros: dados.outros || [] };
    renderLoginsSistema();
  } catch (err) {
    console.error(err);
    if (!err.sessionExpired) dizer("logins-status", `Não foi possível carregar os logins: ${mensagemDoErro(err)}`, true);
  }
}

// ---- wiring ------------------------------------------------------------------

// The e-mail + password block is only offered when the gateway is on (it needs the server).
function prepararTelaDeEntrada() {
  const disponivel = Boolean(CONFIG.GATEWAY_URL) && loginComSenhaDisponivel();
  const bloco = porId("login-senha-bloco");
  if (bloco) bloco.hidden = !disponivel;
}

function setupLoginSenha() {
  if (loginSenhaPronto) return;
  loginSenhaPronto = true;
  montarCamposDeSenha();
  ligarMedidoresDeForca();
  prepararTelaDeEntrada();
  porId("login-senha-form").addEventListener("submit", enviarLoginSenha);
  porId("btn-criar-acesso").addEventListener("click", abrirCadastroSenha);
  porId("btn-esqueci-senha").addEventListener("click", abrirEsqueciSenha);
  porId("cadastro-senha-form").addEventListener("submit", enviarCadastro);
  porId("cadastro-codigo-form").addEventListener("submit", confirmarCodigoDoCadastro);
  porId("btn-reenviar-codigo").addEventListener("click", reenviarCodigoDoCadastro);
  porId("btn-cadastro-voltar").addEventListener("click", () => voltarParaAEntrada(""));
  porId("esqueci-email-form").addEventListener("submit", enviarEsqueciEmail);
  porId("esqueci-nova-form").addEventListener("submit", salvarNovaSenhaDoEsqueci);
  porId("btn-esqueci-voltar").addEventListener("click", () => voltarParaAEntrada(esqueciEmail));
  porId("trocar-senha-form").addEventListener("submit", enviarTrocaDeSenha);
}

setupLoginSenha();
