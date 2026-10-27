// Tela "Extrato Bancário" (Financeiro → Extrato Bancário): importar um OFX/
// CSV, ver as transações por mês, e conciliar cada uma com um Lançamento —
// confirmando uma sugestão automática (mesma conta, mesmo valor, data a até
// 2 dias de distância) ou criando um lançamento novo a partir da transação.
// Cartões reaproveitados de .fornecedor-card/.fornecedor-actions (mesmo
// precedente de Contas a Pagar/Receber reaproveitando Fornecedores — ver
// CLAUDE.md), não uma classe nova. Dados em js/extrato.js.
let extratoLookups = null;
let allExtrato = [];
let extratoUiReady = false;
let extratoImportando = false;

function extratoImportStatus(msg, erro) {
  const el = document.getElementById("extrato-import-status");
  if (el) {
    el.textContent = msg || "";
    el.classList.toggle("status-erro", Boolean(erro));
  }
}

function formatExtratoData(date) {
  return date ? date.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "";
}

function populateExtratoFilterContas() {
  const contas = Array.from(new Set(allExtrato.map((e) => tirarCodigo(e.conta)).filter(Boolean))).sort();
  populateFilterSelect(document.getElementById("extrato-filtro-conta"), contas, "Todas as contas");
}

function getExtratoFiltros() {
  return {
    mes: document.getElementById("extrato-filtro-mes").value, // "YYYY-MM" ou ""
    conta: document.getElementById("extrato-filtro-conta").value,
    status: document.getElementById("extrato-filtro-status").value,
  };
}

function filtrarExtrato(itens, filtros) {
  return itens.filter((item) => {
    if (filtros.mes && item.data) {
      const chave = `${item.data.getUTCFullYear()}-${String(item.data.getUTCMonth() + 1).padStart(2, "0")}`;
      if (chave !== filtros.mes) return false;
    }
    if (filtros.conta && tirarCodigo(item.conta) !== filtros.conta) return false;
    if (filtros.status === "pendente" && item.conciliado) return false;
    if (filtros.status === "conciliado" && !item.conciliado) return false;
    return true;
  });
}

function criarStatExtrato(label, valor) {
  const card = document.createElement("div");
  card.className = "card conta-kpi";
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "conta-kpi-valor";
  v.textContent = valor;
  card.appendChild(l);
  card.appendChild(v);
  return card;
}

function renderExtratoKpis(itens) {
  const entradas = itens.filter((i) => i.valor >= 0).reduce((s, i) => s + i.valor, 0);
  const saidas = itens.filter((i) => i.valor < 0).reduce((s, i) => s + Math.abs(i.valor), 0);
  const pendentes = itens.filter((i) => !i.conciliado).length;
  const host = document.getElementById("extrato-kpis");
  host.innerHTML = "";
  host.appendChild(criarStatExtrato("Entradas do extrato", formatBRL(entradas)));
  host.appendChild(criarStatExtrato("Saídas do extrato", formatBRL(saidas)));
  host.appendChild(criarStatExtrato("Saldo do extrato", formatBRL(entradas - saidas)));
  host.appendChild(criarStatExtrato("Pendentes de conciliar", String(pendentes)));
}

function renderExtratoLista() {
  const filtros = getExtratoFiltros();
  const filtrados = filtrarExtrato(allExtrato, filtros)
    .slice()
    .sort((a, b) => (b.data && a.data ? b.data.getTime() - a.data.getTime() : 0));

  renderExtratoKpis(filtrados);
  const countEl = document.getElementById("extrato-lista-count");
  if (countEl) countEl.textContent = `${filtrados.length} transaç${filtrados.length === 1 ? "ão" : "ões"}`;

  const container = document.getElementById("extrato-lista-container");
  container.innerHTML = "";
  if (!filtrados.length) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Nenhuma transação encontrada.";
    container.appendChild(empty);
    return;
  }
  filtrados.forEach((item) => container.appendChild(buildExtratoCard(item)));
}

function buildExtratoCard(item) {
  const card = document.createElement("div");
  card.className = "fornecedor-card";
  card.dataset.linha = String(item.linha);

  const info = document.createElement("div");
  info.className = "fornecedor-info";
  card.appendChild(info);

  const valorBadge = document.createElement("span");
  valorBadge.className = `fornecedor-status ${item.valor >= 0 ? "lanc-valor-entrada" : "lanc-valor-saida"}`;
  valorBadge.textContent = formatBRL(item.valor);
  card.appendChild(valorBadge);

  renderExtratoView(info, item);
  return card;
}

function renderExtratoView(info, item) {
  info.innerHTML = "";

  const title = document.createElement("div");
  title.className = "fornecedor-title";
  title.textContent = [formatExtratoData(item.data), item.descricao].filter(Boolean).join(" · ");
  info.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "fornecedor-meta";
  meta.textContent = tirarCodigo(item.conta);
  info.appendChild(meta);

  const statusBadge = document.createElement("span");
  statusBadge.className = "estoque-status " + (item.conciliado ? "extrato-status-conciliado" : "extrato-status-pendente");
  statusBadge.textContent = item.conciliado
    ? `Conciliado${item.lancamentoVinculado ? " — Lançamento #" + item.lancamentoVinculado : ""}`
    : "Pendente";
  info.appendChild(statusBadge);

  const actionsHost = document.createElement("div");
  actionsHost.className = "fornecedor-actions-host";
  info.appendChild(actionsHost);
  renderExtratoActions(actionsHost, item, info);
}

function renderExtratoActions(host, item, info) {
  host.innerHTML = "";
  if (!canEdit(currentUserRole)) return;
  const actions = document.createElement("div");
  actions.className = "fornecedor-actions";
  host.appendChild(actions);

  if (item.conciliado) {
    actions.appendChild(
      makeFornecedorActionButton("Desfazer conciliação", async () => {
        try {
          await desfazerConciliacaoExtrato(item, accessToken);
          await refreshExtrato();
        } catch (err) {
          console.error(err);
          alert(describeSaveError(err));
        }
      })
    );
    return;
  }

  const sugestao = sugerirLancamentoParaExtrato(item, allLancamentos);
  if (sugestao) {
    const nota = document.createElement("div");
    nota.className = "fornecedor-meta";
    nota.textContent = `Pode ser o lançamento #${sugestao.linha} (${formatExtratoData(sugestao.data)} · ${formatBRL(sugestao.valor)}${sugestao.categoria ? " · " + sugestao.categoria : ""})`;
    info.insertBefore(nota, host);

    actions.appendChild(
      makeFornecedorActionButton("Confirmar vínculo", async () => {
        try {
          await marcarExtratoConciliado(item, sugestao.linha, accessToken);
          await refreshExtrato();
        } catch (err) {
          console.error(err);
          alert(describeSaveError(err));
        }
      })
    );
  }

  actions.appendChild(makeFornecedorActionButton("Criar lançamento", () => showExtratoCriarPanel(info, item)));
}

function showExtratoCriarPanel(info, item) {
  info.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "fornecedor-inline-panel";

  const lojaSelect = document.createElement("select");
  populateSelect(lojaSelect, extratoLookups.lojas, "Loja");
  panel.appendChild(lojaSelect);

  const empresaSelect = document.createElement("select");
  populateSelect(empresaSelect, extratoLookups.empresas, "Empresa");
  panel.appendChild(empresaSelect);

  const categoriaSelect = document.createElement("select");
  populateSelect(categoriaSelect, extratoLookups.categorias, "Categoria");
  panel.appendChild(categoriaSelect);

  const pessoaSelect = document.createElement("select");
  populateSelect(pessoaSelect, extratoLookups.pessoas, "Pessoa");
  panel.appendChild(pessoaSelect);

  const dataInput = document.createElement("input");
  dataInput.type = "date";
  dataInput.value = item.data ? toInputDateValueUTC(item.data) : toInputDateValueUTC(new Date());
  panel.appendChild(dataInput);

  const statusEl = document.createElement("span");
  statusEl.className = "status-message";
  panel.appendChild(statusEl);

  const confirmBtn = makeFornecedorActionButton(
    "Confirmar",
    async () => {
      if (!lojaSelect.value || !empresaSelect.value || !categoriaSelect.value || !pessoaSelect.value || !dataInput.value) {
        statusEl.textContent = "Preencha loja, empresa, categoria, pessoa e data.";
        return;
      }
      confirmBtn.disabled = true;
      statusEl.textContent = "Salvando...";
      try {
        await criarLancamentoDeExtrato(
          item,
          { loja: lojaSelect.value, empresa: empresaSelect.value, categoria: categoriaSelect.value, pessoa: pessoaSelect.value, data: dataInput.value },
          accessToken
        );
        await refreshExtrato();
      } catch (err) {
        console.error(err);
        confirmBtn.disabled = false;
        statusEl.textContent = mensagemDoErro(err);
      }
    }
  );
  panel.appendChild(confirmBtn);
  panel.appendChild(makeFornecedorActionButton("Cancelar", () => renderExtratoView(info, item)));

  info.appendChild(panel);
}

async function refreshExtrato() {
  allExtrato = await fetchExtrato(accessToken);
  populateExtratoFilterContas();
  renderExtratoLista();
}

function setupExtratoUi() {
  if (extratoUiReady) return;
  extratoUiReady = true;

  document.getElementById("extrato-import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (extratoImportando) return;
    const contaValue = document.getElementById("extrato-import-conta").value;
    const fileInput = document.getElementById("extrato-import-arquivo");
    const file = fileInput.files && fileInput.files[0];
    if (!contaValue) return extratoImportStatus("Selecione a conta.", true);
    if (!file) return extratoImportStatus("Escolha um arquivo .ofx, .csv ou .xlsx.", true);

    extratoImportando = true;
    const submitBtn = document.getElementById("btn-importar-extrato");
    submitBtn.disabled = true;
    extratoImportStatus("Lendo arquivo...");
    try {
      const transacoes = await parseArquivoExtratoAsync(file);
      if (!transacoes.length) {
        extratoImportStatus("Não encontrei nenhuma transação nesse arquivo.", true);
        return;
      }
      const { importadas, duplicadas } = await importarExtratoTransacoes(transacoes, contaValue, accessToken, (feito, total) => {
        extratoImportStatus(`Importando ${feito} de ${total}...`);
      });
      extratoImportStatus(`${importadas} transaç${importadas === 1 ? "ão" : "ões"} importada(s)${duplicadas ? `, ${duplicadas} já existia(m)` : ""}.`);
      fileInput.value = "";
      await refreshExtrato();
    } catch (err) {
      console.error(err);
      extratoImportStatus(`Erro ao importar: ${mensagemDoErro(err)}`, true);
    } finally {
      extratoImportando = false;
      submitBtn.disabled = false;
    }
  });

  ["extrato-filtro-mes", "extrato-filtro-conta", "extrato-filtro-status"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderExtratoLista);
  });
}

function initExtratoUi(extrato, lookups) {
  extratoLookups = lookups;
  allExtrato = extrato;
  setupExtratoUi();
  populateSelect(document.getElementById("extrato-import-conta"), lookups.contas, "Selecione a conta");
  populateExtratoFilterContas();
  renderExtratoLista();
}
