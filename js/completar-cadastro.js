// "Login próprio": someone a company Master already authorized (is in that
// company's Usuários) can also create an e-mail + senha login, so they stop
// having to redo the ~hourly Google sign-in every time (see CLAUDE.md,
// "Manter conectado..."). Both entry points below call the same gateway
// action (completarCadastroAutorizado) and share the same validation:
//  - right after a Google sign-in, if this account has no password yet
//    (mostrarCompletarCadastro, shown by resolveProfileAndEnter in js/app.js —
//    skippable, so it is never a dead end);
//  - anytime later, from Ajustes (setupCriarSenhaAjustes), for anyone who skipped.
// The permissions (Perfil) are untouched by this screen: they stay whatever
// the company's Master set in Usuários, exactly as before.

let completarCadastroContexto = null;

function validarCamposDeLoginESenha(prefixo, statusId, email) {
  const login = porId(`${prefixo}-login`).value.trim();
  const funcao = porId(`${prefixo}-funcao`).value.trim();
  const senha = porId(`${prefixo}-senha`).value;
  const confirmar = porId(`${prefixo}-confirmar`).value;
  if (!loginParecido(login)) {
    dizer(statusId, "Escolha um login com 3 a 30 letras, números, ponto, hífen ou underline.", true);
    return null;
  }
  if (!funcao) {
    dizer(statusId, "Informe a sua função na empresa.", true);
    return null;
  }
  const forca = avaliarSenha(senha, email || "");
  if (!forca.ok) {
    dizer(statusId, forca.dica || "Escolha uma senha mais forte.", true);
    return null;
  }
  if (senha !== confirmar) {
    dizer(statusId, "As duas senhas não são iguais.", true);
    return null;
  }
  return { login, funcao, senha };
}

// ---- right after Google sign-in --------------------------------------------

function mostrarCompletarCadastro(email, token, usuario) {
  completarCadastroContexto = { email, token, usuario };
  hideAllScreens();
  porId("completar-cadastro-screen").hidden = false;
  porId("cc-email-mostrado").textContent = email;
  porId("cc-email-oculto").value = email;
  porId("cc-nome").value = (usuario && usuario.nome) || "";
  porId("cc-login").value = "";
  porId("cc-funcao").value = "";
  limparCamposDeSenha(porId("completar-cadastro-screen"));
  dizer("completar-cadastro-status", "", false);
}

async function enviarCompletarCadastro(evento) {
  evento.preventDefault();
  if (!completarCadastroContexto) return;
  const { email, token, usuario } = completarCadastroContexto;
  const nome = porId("cc-nome").value.trim();
  if (!nome) return dizer("completar-cadastro-status", "Informe o seu nome.", true);
  const campos = validarCamposDeLoginESenha("cc", "completar-cadastro-status", email);
  if (!campos) return;
  const botao = porId("btn-completar-cadastro");
  botao.disabled = true;
  dizer("completar-cadastro-status", "Salvando...", false);
  try {
    const chave = await derivarChaveDeSenha(campos.senha, email);
    await gatewayCall("completarCadastroAutorizado", { nome, login: campos.login, funcao: campos.funcao, chave }, token);
    currentTemSenhaAtiva = true;
    completarCadastroContexto = null;
    await startApp(token, usuario.nome, usuario.perfil, usuario.linha);
  } catch (err) {
    console.error(err);
    dizer("completar-cadastro-status", mensagemDoErro(err), true);
    botao.disabled = false;
  }
}

function pularCompletarCadastro() {
  if (!completarCadastroContexto) return;
  const { token, usuario } = completarCadastroContexto;
  completarCadastroContexto = null;
  startApp(token, usuario.nome, usuario.perfil, usuario.linha);
}

function setupCompletarCadastroScreen() {
  porId("completar-cadastro-form").addEventListener("submit", enviarCompletarCadastro);
  porId("btn-completar-cadastro-pular").addEventListener("click", pularCompletarCadastro);
}

setupCompletarCadastroScreen();

// ---- from Ajustes, for anyone who skipped it at login -----------------------

function setupCriarSenhaAjustes() {
  porId("ajustes-criar-senha-form").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const campos = validarCamposDeLoginESenha("acs", "ajustes-criar-senha-status", currentEmail);
    if (!campos) return;
    const botao = porId("btn-ajustes-criar-senha");
    botao.disabled = true;
    dizer("ajustes-criar-senha-status", "Salvando...", false);
    try {
      const chave = await derivarChaveDeSenha(campos.senha, currentEmail);
      await gatewayCall("completarCadastroAutorizado", { nome: userStatus.textContent, login: campos.login, funcao: campos.funcao, chave }, accessToken);
      currentTemSenhaAtiva = true;
      porId("ajustes-criar-senha-card").hidden = true;
      limparCamposDeSenha(porId("ajustes-criar-senha-form"));
    } catch (err) {
      console.error(err);
      dizer("ajustes-criar-senha-status", mensagemDoErro(err), true);
    } finally {
      botao.disabled = false;
    }
  });
}
