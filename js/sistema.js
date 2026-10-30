// Painel do sistema: the developer / system-administrator console. It lives
// OUTSIDE any company: no lançamentos, no estoque, no company data is loaded
// here. It only handles who gets access to the app — access requests and
// creating companies — plus a read-only overview of the companies that exist.
// The server enforces it (ADMIN_EMAILS only; a system admin cannot read a
// company's data unless they were explicitly added to it).

const SISTEMA_KEY = "__sistema__";
let sistemaReady = false;
let sistemaEmpresas = [];
let pedidosPendentes = [];
let pedidoEmAtendimento = null; // request (row) the create-company form was filled from
let pedidoEncaminharAberto = null;
let pedidoRecusarConfirma = null;

function sistemaStatus(id, message) {
  const el = document.getElementById(id);
  if (el) el.textContent = message || "";
}

function formatPedidoData(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR");
}

// ---- companies overview ---------------------------------------------------

async function loadEmpresasSistema() {
  try {
    const data = await gatewayCall("listCompanies", {}, accessToken);
    sistemaEmpresas = data.empresas || [];
    renderEmpresasSistema();
    renderMetricasSistema();
  } catch (err) {
    console.error(err);
    if (!err.sessionExpired) sistemaStatus("sistema-empresas-status", `Não foi possível carregar as empresas: ${mensagemDoErro(err)}`);
  }
}

// Days left on a company's trial (testeExpiraEm, a date serial — same epoch
// sheetSerialToDate already converts, see js/lancamentos.js), or null for a
// company with no trial clock at all (a "fixa" company, or one created
// through the admin-only Painel do sistema path — see actionListCompanies_'s
// own comment in Code.gs for why that distinction exists).
function diasRestantesTeste(testeExpiraEm) {
  if (typeof testeExpiraEm !== "number") return null;
  const data = sheetSerialToDate(testeExpiraEm);
  if (!data) return null;
  const hoje = new Date();
  const hojeUTC = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const alvoUTC = Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), data.getUTCDate());
  return Math.round((alvoUTC - hojeUTC) / 86400000);
}

// Deliberately only the metrics that have REAL data behind them today: MRR
// and taxa de conversão (asked for in the original SaaS-roadmap planning —
// see CLAUDE.md "Virar um SaaS de verdade") need a real paying/not-paying
// signal that only exists once billing (Fase 3) is built, which is itself
// blocked on the CNPJ being formalized. Showing a number for either here
// would be inventing data, not reporting it — the field-hint next to this
// card says so in the UI instead of a fake "R$ 0,00" tile.
function renderMetricasSistema() {
  const container = document.getElementById("sistema-metricas-kpis");
  if (!container) return;
  container.innerHTML = "";
  const ativas = sistemaEmpresas.filter((e) => e.ativa);
  const inativas = sistemaEmpresas.filter((e) => !e.ativa);
  const emTeste = ativas.filter((e) => typeof e.testeExpiraEm === "number");
  const semTeste = ativas.filter((e) => typeof e.testeExpiraEm !== "number");
  const vencendoEmBreve = emTeste.filter((e) => {
    const dias = diasRestantesTeste(e.testeExpiraEm);
    return dias !== null && dias <= 3;
  });

  // Short labels on purpose — a long phrase here overflows the fixed-width
  // span-3 tile (the same clipping the dashboard's own KPI tiles have been
  // fixed for before; see the "A KPI label could wrap mid-phrase" note in
  // CLAUDE.md). What each short label means lives in the field-hint below
  // the row instead, which has room to wrap normally.
  container.appendChild(buildKpiTile({ label: "Empresas", value: String(sistemaEmpresas.length), icon: KPI_ICONS.scale, iconClass: "neutral" }));
  container.appendChild(buildKpiTile({ label: "Ativas", value: String(ativas.length), icon: KPI_ICONS.up, iconClass: "success" }));
  container.appendChild(buildKpiTile({ label: "Em teste", value: String(emTeste.length), icon: KPI_ICONS.scale, iconClass: vencendoEmBreve.length ? "danger" : "neutral" }));
  container.appendChild(buildKpiTile({ label: "Sem teste", value: String(semTeste.length), icon: KPI_ICONS.up, iconClass: "neutral" }));
  container.appendChild(buildKpiTile({ label: "Inativas", value: String(inativas.length), icon: KPI_ICONS.down, iconClass: inativas.length ? "danger" : "neutral" }));

  const aviso = document.getElementById("sistema-metricas-aviso");
  if (aviso) {
    if (vencendoEmBreve.length > 0) {
      const nomes = vencendoEmBreve.map((e) => e.empresa).join(", ");
      aviso.textContent = `${vencendoEmBreve.length} empresa(s) em teste grátis vencendo em até 3 dias: ${nomes}.`;
      aviso.hidden = false;
    } else {
      aviso.hidden = true;
    }
  }
}

// "Excluir" uma empresa aqui é reversível de propósito (mesmo padrão de
// Fornecedores Ativo/Inativo e Contas Cancelada/Reabrir neste app) — os
// dados continuam guardados, só o acesso de todo mundo àquela empresa é
// cortado. Uma empresa "fixa" (Ipanema, Carolina — cadastradas direto no
// Code.gs) não tem esse botão: o servidor já recusaria a ação, então nem
// oferecemos o botão para não prometer algo que vai falhar.
async function alternarEmpresaAtiva(empresa, ativa) {
  const confirmado = ativa
    ? true
    : confirm(`Excluir "${empresa.empresa}"? Ela deixa de ser acessível para qualquer pessoa, mas os dados continuam guardados — você pode reverter isso depois.`);
  if (!confirmado) return;
  sistemaStatus("sistema-empresas-status", ativa ? "Restaurando..." : "Excluindo...");
  try {
    await gatewayCall("setCompanyActive", { spreadsheetId: empresa.spreadsheetId, ativa }, accessToken);
    await loadEmpresasSistema();
    sistemaStatus("sistema-empresas-status", ativa ? `"${empresa.empresa}" foi restaurada.` : `"${empresa.empresa}" foi excluída (os dados continuam guardados).`);
  } catch (err) {
    console.error(err);
    if (!err.sessionExpired) sistemaStatus("sistema-empresas-status", `Erro: ${mensagemDoErro(err)}`);
  }
}

function renderEmpresasSistema() {
  const list = document.getElementById("sistema-empresas");
  list.innerHTML = "";
  if (sistemaEmpresas.length === 0) {
    const li = document.createElement("li");
    li.className = "lista-vazia";
    li.textContent = "Nenhuma empresa cadastrada.";
    list.appendChild(li);
    return;
  }
  sistemaEmpresas.forEach((empresa) => {
    const li = document.createElement("li");
    li.className = "pedido-card";
    const nome = document.createElement("div");
    nome.className = "pedido-titulo";
    nome.textContent = empresa.ativa ? empresa.empresa : `${empresa.empresa} (excluída)`;
    li.appendChild(nome);
    const meta = document.createElement("div");
    meta.className = "pedido-meta";
    const masters = empresa.masters.map((m) => m.email).join(", ") || "sem administrador";
    const seg = getSegmento(empresa.segmento);
    meta.textContent = `${seg.nome} · ${empresa.origem === "fixa" ? "cadastrada no servidor" : "criada pelo app"} · ${empresa.usuarios} pessoa(s) · Master: ${masters}`;
    li.appendChild(meta);

    if (empresa.origem === "criada") {
      const acoes = document.createElement("div");
      acoes.className = "pedido-acoes";
      acoes.appendChild(
        empresa.ativa
          ? makeAdminButton("Excluir", () => alternarEmpresaAtiva(empresa, false), "usuario-action-danger")
          : makeAdminButton("Restaurar", () => alternarEmpresaAtiva(empresa, true), "usuario-action-primary")
      );
      li.appendChild(acoes);
    }

    list.appendChild(li);
  });
}

// ---- create a company -----------------------------------------------------

function setupSistema() {
  if (sistemaReady) return;
  sistemaReady = true;

  const segmentoSelect = document.getElementById("empresa-add-segmento");
  Object.keys(SEGMENTOS).forEach((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = SEGMENTOS[id].nome;
    segmentoSelect.appendChild(option);
  });
  segmentoSelect.value = "outro";

  const form = document.getElementById("empresa-add-form");
  const statusEl = document.getElementById("empresa-add-status");
  const submitButton = document.getElementById("btn-empresa-add");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nome = document.getElementById("empresa-add-nome").value.trim();
    const ownerEmail = document.getElementById("empresa-add-email").value.trim();
    const ownerNome = document.getElementById("empresa-add-dono").value.trim();
    const incluirMeuAcesso = document.getElementById("empresa-add-meu-acesso").checked;
    const segmento = segmentoSelect.value;

    if (!nome || !ownerEmail || !ownerNome) {
      statusEl.textContent = "Preencha o nome da empresa, o e-mail e o nome do administrador.";
      return;
    }
    if (!looksLikeEmail(ownerEmail)) {
      statusEl.textContent = "Informe um e-mail válido.";
      return;
    }

    submitButton.disabled = true;
    statusEl.textContent = "Criando a empresa... isso leva alguns segundos.";
    try {
      await gatewayCall("createCompany", { nome, ownerEmail, ownerNome, incluirMeuAcesso, segmento }, accessToken);
      form.reset();
      segmentoSelect.value = "outro";
      let aviso = "";
      if (pedidoEmAtendimento) {
        try {
          await gatewayCall("resolveRequest", { linha: pedidoEmAtendimento, status: "Atendida" }, accessToken);
          aviso = " O pedido foi marcado como atendido e a pessoa foi avisada por e-mail.";
        } catch (err) {
          console.error(err);
          aviso = " (A empresa foi criada, mas não consegui marcar o pedido como atendido.)";
        }
        pedidoEmAtendimento = null;
      }
      await Promise.all([loadPedidosSistema(), loadEmpresasSistema()]);
      statusEl.textContent = `Empresa "${nome}" criada. ${ownerNome} já pode entrar com a conta ${ownerEmail.toLowerCase()}.${aviso}`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Não foi possível criar: ${mensagemDoErro(err)}`;
    } finally {
      submitButton.disabled = false;
    }
  });

  const refreshButton = document.getElementById("btn-sistema-atualizar");
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = "Atualizando…";
    await Promise.all([loadPedidosSistema(), loadEmpresasSistema(), carregarLoginsSistema()]);
    refreshButton.textContent = "Atualizado";
    setTimeout(() => {
      refreshButton.textContent = "Atualizar";
      refreshButton.disabled = false;
    }, 1500);
  });
  document.getElementById("btn-sistema-abrir-empresa").addEventListener("click", () => {
    showCompanyPicker(currentCompanies, accessToken, currentEmail);
  });
  document.getElementById("btn-sistema-sair").addEventListener("click", () => {
    forgetSessionPlace();
    signOut();
    showLogin();
  });
}

function showSistemaScreen() {
  hideAllScreens();
  sistemaScreen.hidden = false;
  rememberCompany(SISTEMA_KEY);
  setupSistema();
  document.getElementById("sistema-email").textContent = currentEmail || "";
  document.getElementById("btn-sistema-abrir-empresa").hidden = currentCompanies.length === 0;
  loadPedidosSistema();
  loadEmpresasSistema();
  carregarLoginsSistema();
}

// ---- access requests ------------------------------------------------------

async function loadPedidosSistema() {
  try {
    const data = await gatewayCall("listRequests", {}, accessToken);
    pedidosPendentes = data.pendentes || [];
    document.getElementById("sistema-pedidos-contador").textContent = pedidosPendentes.length ? `(${pedidosPendentes.length})` : "";
    renderPedidosSistema();
  } catch (err) {
    console.error(err);
    if (!err.sessionExpired) sistemaStatus("pedidos-status", `Não foi possível carregar os pedidos: ${mensagemDoErro(err)}`);
  }
}

async function resolverPedido(pedido, status, nota) {
  await gatewayCall("resolveRequest", { linha: pedido.linha, status, nota }, accessToken);
  pedidoEncaminharAberto = null;
  pedidoRecusarConfirma = null;
  await loadPedidosSistema();
}

function preencherCriarEmpresa(pedido) {
  pedidoEmAtendimento = pedido.linha;
  document.getElementById("empresa-add-nome").value = pedido.empresa;
  document.getElementById("empresa-add-email").value = pedido.email;
  document.getElementById("empresa-add-dono").value = pedido.nome;
  document.getElementById("empresa-add-status").textContent = `Dados do pedido de ${pedido.nome} preenchidos. Confira e clique em "Criar empresa".`;
  const field = document.getElementById("empresa-add-nome");
  field.scrollIntoView({ behavior: "smooth", block: "center" });
  field.focus();
}

function renderPedidosSistema() {
  const box = document.getElementById("pedidos-lista");
  if (!box) return;
  box.innerHTML = "";
  if (pedidosPendentes.length === 0) {
    const p = document.createElement("p");
    p.className = "lista-vazia";
    p.textContent = "Nenhum pedido em análise.";
    box.appendChild(p);
    return;
  }

  pedidosPendentes.forEach((pedido) => {
    const card = document.createElement("div");
    card.className = "pedido-card";

    const titulo = document.createElement("div");
    titulo.className = "pedido-titulo";
    titulo.textContent = `${pedido.nome} — ${pedido.email}`;
    card.appendChild(titulo);

    const meta = document.createElement("div");
    meta.className = "pedido-meta";
    const tipoTxt = pedido.tipo === "nova" ? "quer usar na própria empresa" : "diz trabalhar em empresa que já usa";
    meta.textContent = [pedido.empresa, tipoTxt, formatPedidoData(pedido.data)].filter(Boolean).join(" · ");
    card.appendChild(meta);

    if (pedido.mensagem) {
      const msg = document.createElement("div");
      msg.className = "pedido-mensagem";
      msg.textContent = pedido.mensagem;
      card.appendChild(msg);
    }

    const acoes = document.createElement("div");
    acoes.className = "pedido-acoes";

    if (pedido.tipo === "nova") {
      acoes.appendChild(makeAdminButton("Criar empresa", () => preencherCriarEmpresa(pedido), "usuario-action-primary"));
    } else {
      acoes.appendChild(
        makeAdminButton(
          "Encaminhar à empresa",
          () => {
            pedidoEncaminharAberto = pedidoEncaminharAberto === pedido.linha ? null : pedido.linha;
            pedidoRecusarConfirma = null;
            renderPedidosSistema();
          },
          "usuario-action-primary"
        )
      );
    }

    if (pedidoRecusarConfirma === pedido.linha) {
      acoes.appendChild(
        makeAdminButton(
          "Confirmar recusa",
          async () => {
            try {
              await resolverPedido(pedido, "Recusada", "");
              sistemaStatus("pedidos-status", `Pedido de ${pedido.nome} recusado. A pessoa foi avisada por e-mail.`);
            } catch (err) {
              console.error(err);
              sistemaStatus("pedidos-status", `Erro: ${mensagemDoErro(err)}`);
            }
          },
          "usuario-action-danger"
        )
      );
      acoes.appendChild(makeAdminButton("Cancelar", () => { pedidoRecusarConfirma = null; renderPedidosSistema(); }));
    } else {
      acoes.appendChild(
        makeAdminButton("Recusar", () => {
          pedidoRecusarConfirma = pedido.linha;
          pedidoEncaminharAberto = null;
          renderPedidosSistema();
        }, "usuario-action-danger-soft")
      );
    }
    card.appendChild(acoes);

    if (pedidoEncaminharAberto === pedido.linha) {
      const enc = document.createElement("div");
      enc.className = "pedido-add";
      const dica = document.createElement("div");
      dica.className = "pedido-mensagem";
      dica.textContent = "Quem decide é o administrador da empresa: ele recebe um e-mail e cadastra a pessoa no perfil dele.";
      enc.appendChild(dica);
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", "Empresa");
      const alvo = pedido.empresa.trim().toLowerCase();
      sistemaEmpresas.forEach((c) => {
        const o = document.createElement("option");
        o.value = c.spreadsheetId;
        o.textContent = c.empresa;
        if (c.empresa.trim().toLowerCase() === alvo) o.selected = true;
        sel.appendChild(o);
      });
      enc.appendChild(sel);
      enc.appendChild(
        makeAdminButton(
          "Encaminhar",
          async () => {
            sistemaStatus("pedidos-status", "Encaminhando...");
            try {
              await gatewayCall("forwardRequest", { linha: pedido.linha, spreadsheetId: sel.value }, accessToken);
              pedidoEncaminharAberto = null;
              await loadPedidosSistema();
              sistemaStatus("pedidos-status", `Pedido de ${pedido.nome} encaminhado ao administrador da empresa.`);
            } catch (err) {
              console.error(err);
              sistemaStatus("pedidos-status", `Erro ao encaminhar: ${mensagemDoErro(err)}`);
            }
          },
          "usuario-action-primary"
        )
      );
      card.appendChild(enc);
    }

    box.appendChild(card);
  });
}
