// One generic UI module for both Contas a Pagar and Contas a Receber — same
// shape, same actions, only id prefixes/labels differ (see CONTAS_CONFIG in
// js/contas.js). "tipo" is "pagar" or "receber" throughout.
let allContas = { pagar: [], receber: [] };
let contasFormInitialized = { pagar: false, receber: false };
let contasFilterHandlersReady = { pagar: false, receber: false };

function idp(tipo) {
  return tipo === "pagar" ? "contas-pagar" : "contas-receber";
}

// --- Filters -----------------------------------------------------------------

function getContasFilters(tipo) {
  const p = idp(tipo);
  return {
    status: document.getElementById(`${p}-filtro-status`).value,
    categoria: document.getElementById(`${p}-filtro-categoria`).value,
    busca: document.getElementById(`${p}-busca`).value.trim().toLowerCase(),
  };
}

function populateContasFilterOptions(tipo, items) {
  const categorias = Array.from(new Set(items.map((c) => c.categoria).filter(Boolean))).sort();
  populateFilterSelect(document.getElementById(`${idp(tipo)}-filtro-categoria`), categorias, "Todas as categorias");
}

function filterContas(tipo, items, filters) {
  return items.filter((item) => {
    const statusEfetivo = ehContaAtrasada(item) ? "Atrasado" : item.status;
    if (filters.status && statusEfetivo !== filters.status) return false;
    if (filters.categoria && item.categoria !== filters.categoria) return false;
    if (filters.busca) {
      const haystack = [item.descricao, item.contraparte, item.categoria, item.observacao].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(filters.busca)) return false;
    }
    return true;
  });
}

// --- KPI strip -----------------------------------------------------------------

function renderContasKpis(tipo, items) {
  const cfg = CONTAS_CONFIG[tipo];
  const abertas = items.filter((i) => i.status === cfg.statusAberto);
  const atrasadas = abertas.filter(ehContaAtrasada);
  const hoje = new Date();
  const fechadasEsteMes = items.filter(
    (i) => i.status === cfg.statusFechado && i.dataFechamento && i.dataFechamento.getUTCFullYear() === hoje.getFullYear() && i.dataFechamento.getUTCMonth() === hoje.getMonth()
  );
  const somar = (lista) => lista.reduce((acc, i) => acc + (i.valor || 0), 0);

  const host = document.getElementById(`${idp(tipo)}-kpis`);
  host.innerHTML = "";
  [
    { label: "Pendente", valor: somar(abertas), destaque: false },
    { label: "Atrasadas", valor: somar(atrasadas), destaque: true },
    { label: tipo === "pagar" ? "Pago este mês" : "Recebido este mês", valor: somar(fechadasEsteMes), destaque: false },
  ].forEach((stat) => {
    const card = document.createElement("div");
    card.className = "card conta-kpi";
    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = stat.label;
    const valor = document.createElement("div");
    valor.className = "conta-kpi-valor" + (stat.destaque && stat.valor > 0 ? " conta-kpi-alerta" : "");
    valor.textContent = formatBRL(stat.valor);
    card.appendChild(label);
    card.appendChild(valor);
    host.appendChild(card);
  });
}

// --- List rendering ------------------------------------------------------------

function renderContasList(tipo) {
  const filters = getContasFilters(tipo);
  const filtered = filterContas(tipo, allContas[tipo], filters);
  const container = document.getElementById(`${idp(tipo)}-lista-container`);
  container.innerHTML = "";

  renderContasKpis(tipo, allContas[tipo]);

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Nenhuma conta encontrada.";
    container.appendChild(empty);
    return;
  }

  filtered
    .slice()
    .sort((a, b) => (a.vencimento && b.vencimento ? a.vencimento - b.vencimento : 0))
    .forEach((item) => container.appendChild(buildContaCard(tipo, item)));
}

function contaStatusLabel(item) {
  if (ehContaAtrasada(item)) return "Atrasado";
  return item.status;
}

function contaStatusClass(item) {
  if (ehContaAtrasada(item)) return "conta-status-atrasado";
  if (item.status === CONTAS_CONFIG[item.tipo].statusAberto) return "conta-status-pendente";
  return "fornecedor-status-ativo";
}

function buildContaCard(tipo, item) {
  const card = document.createElement("div");
  card.className = "fornecedor-card";
  card.dataset.linha = String(item.linha);

  const info = document.createElement("div");
  info.className = "fornecedor-info";
  card.appendChild(info);

  const statusBadge = document.createElement("span");
  statusBadge.className = `fornecedor-status ${contaStatusClass(item)}`;
  statusBadge.textContent = contaStatusLabel(item);
  card.appendChild(statusBadge);

  renderContaView(tipo, info, item);
  return card;
}

function renderContaView(tipo, info, item) {
  const cfg = CONTAS_CONFIG[tipo];
  info.innerHTML = "";

  const title = document.createElement("div");
  title.className = "fornecedor-title";
  title.textContent = item.contraparte ? `${item.descricao} · ${item.contraparte}` : item.descricao;
  info.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "fornecedor-meta";
  const metaParts = [formatBRL(item.valor)];
  if (item.vencimento) metaParts.push(`Vencimento ${item.vencimento.toLocaleDateString("pt-BR", { timeZone: "UTC" })}`);
  if (item.categoria) metaParts.push(item.categoria);
  if (item.recorrente) metaParts.push("Recorrente");
  meta.textContent = metaParts.join(" · ");
  info.appendChild(meta);

  if (item.status === cfg.statusFechado && item.dataFechamento) {
    const pago = document.createElement("div");
    pago.className = "fornecedor-meta";
    pago.textContent = `${tipo === "pagar" ? "Pago" : "Recebido"} em ${item.dataFechamento.toLocaleDateString("pt-BR", { timeZone: "UTC" })}`;
    info.appendChild(pago);
  }

  if (item.observacao) {
    const obs = document.createElement("div");
    obs.className = "fornecedor-obs";
    obs.textContent = item.observacao;
    info.appendChild(obs);
  }

  const actionsHost = document.createElement("div");
  actionsHost.className = "fornecedor-actions-host";
  info.appendChild(actionsHost);
  renderContaActions(tipo, actionsHost, item, info);
}

function renderContaActions(tipo, host, item, info) {
  const cfg = CONTAS_CONFIG[tipo];
  host.innerHTML = "";
  if (!canEdit(currentUserRole)) return;
  if (item.status === cfg.statusFechado) return;

  const actions = document.createElement("div");
  actions.className = "fornecedor-actions";
  actions.appendChild(
    makeFornecedorActionButton(tipo === "pagar" ? "Pagar" : "Receber", () => showContaSettlePanel(tipo, info, item))
  );
  actions.appendChild(makeFornecedorActionButton("Editar", () => showContaEditPanel(tipo, info, item)));
  host.appendChild(actions);
}

// --- Settle ("Pagar" / "Receber") — asks for the real-world details a
// Lançamento needs (Loja/Conta/Empresa/Pessoa), same lookups the "Novo
// lançamento" form uses. ----------------------------------------------------

function showContaSettlePanel(tipo, info, item) {
  const cfg = CONTAS_CONFIG[tipo];
  info.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "fornecedor-inline-panel";

  const lojaSelect = document.createElement("select");
  populateSelect(lojaSelect, contasLookups.lojas, "Loja");
  panel.appendChild(lojaSelect);

  const contaSelect = document.createElement("select");
  populateSelect(contaSelect, contasLookups.contas, "Conta");
  panel.appendChild(contaSelect);

  const empresaSelect = document.createElement("select");
  populateSelect(empresaSelect, contasLookups.empresas, "Empresa");
  panel.appendChild(empresaSelect);

  const categoriaSelect = document.createElement("select");
  populateSelect(categoriaSelect, contasLookups.categorias, "Categoria");
  // Pre-select a matching category when the conta's own text matches one of
  // the ledger's existing category labels exactly — a convenience, not a
  // requirement (the person can always pick a different one).
  const categoriaMatch = contasLookups.categorias.find((c) => stripCode(c.label) === item.categoria || c.value === item.categoria);
  if (categoriaMatch) categoriaSelect.value = categoriaMatch.value;
  panel.appendChild(categoriaSelect);

  const pessoaSelect = document.createElement("select");
  populateSelect(pessoaSelect, contasLookups.pessoas, `${cfg.contraparteLabel} (Pessoa)`);
  const pessoaMatch = contasLookups.pessoas.find((p) => stripCode(p.label) === item.contraparte || p.value === item.contraparte);
  if (pessoaMatch) pessoaSelect.value = pessoaMatch.value;
  panel.appendChild(pessoaSelect);

  const dataInput = document.createElement("input");
  dataInput.type = "date";
  dataInput.value = new Date().toISOString().slice(0, 10);
  panel.appendChild(dataInput);

  const statusEl = document.createElement("span");
  statusEl.className = "status-message";
  panel.appendChild(statusEl);

  const confirmBtn = makeFornecedorActionButton(tipo === "pagar" ? "Confirmar pagamento" : "Confirmar recebimento", async () => {
    if (!lojaSelect.value || !contaSelect.value || !empresaSelect.value || !categoriaSelect.value || !pessoaSelect.value || !dataInput.value) {
      statusEl.textContent = "Preencha loja, conta, empresa, categoria, pessoa e data.";
      return;
    }
    confirmBtn.disabled = true;
    statusEl.textContent = "Salvando...";
    try {
      await settleConta(
        tipo,
        item,
        {
          dataFechamento: dataInput.value,
          loja: lojaSelect.value,
          contaBancaria: contaSelect.value,
          empresa: empresaSelect.value,
          categoria: categoriaSelect.value,
          pessoa: pessoaSelect.value,
        },
        accessToken
      );
      await refreshContas(tipo);
    } catch (err) {
      console.error(err);
      confirmBtn.disabled = false;
      statusEl.textContent = mensagemDoErro(err);
    }
  });
  panel.appendChild(confirmBtn);
  panel.appendChild(makeFornecedorActionButton("Cancelar", () => renderContaView(tipo, info, item)));

  info.appendChild(panel);
}

function showContaEditPanel(tipo, info, item) {
  info.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "fornecedor-inline-panel";

  const fields = [
    { key: "descricao", label: "Descrição", value: item.descricao, type: "text" },
    { key: "contraparte", label: CONTAS_CONFIG[tipo].contraparteLabel, value: item.contraparte, type: "text" },
    { key: "categoria", label: "Categoria", value: item.categoria, type: "text" },
    { key: "valor", label: "Valor", value: item.valor, type: "number" },
    { key: "vencimento", label: "Vencimento", value: item.vencimento ? toInputDateValueUTC(item.vencimento) : "", type: "date" },
    { key: "observacao", label: "Observação", value: item.observacao, type: "text" },
  ];

  const inputs = {};
  fields.forEach((field) => {
    const input = document.createElement("input");
    input.type = field.type;
    if (field.type === "number") {
      input.step = "0.01";
      input.min = "0";
    }
    input.placeholder = field.label;
    input.value = field.value || "";
    inputs[field.key] = input;
    panel.appendChild(input);
  });

  const recorrenteLabel = document.createElement("label");
  recorrenteLabel.style.display = "flex";
  recorrenteLabel.style.alignItems = "center";
  recorrenteLabel.style.gap = "0.3rem";
  const recorrenteInput = document.createElement("input");
  recorrenteInput.type = "checkbox";
  recorrenteInput.style.width = "auto";
  recorrenteInput.checked = item.recorrente;
  recorrenteLabel.appendChild(recorrenteInput);
  recorrenteLabel.appendChild(document.createTextNode("Recorrente"));
  panel.appendChild(recorrenteLabel);

  const statusEl = document.createElement("span");
  statusEl.className = "status-message";
  panel.appendChild(statusEl);

  const confirmBtn = makeFornecedorActionButton("Salvar", async () => {
    const descricao = inputs.descricao.value.trim();
    if (!descricao || !inputs.vencimento.value || !inputs.valor.value) {
      statusEl.textContent = "Informe descrição, valor e vencimento.";
      return;
    }
    confirmBtn.disabled = true;
    statusEl.textContent = "Salvando...";
    try {
      await updateConta(
        tipo,
        item,
        {
          descricao,
          contraparte: inputs.contraparte.value.trim(),
          categoria: inputs.categoria.value.trim(),
          valor: Number(inputs.valor.value),
          vencimentoSerial: dateInputToSheetSerial(inputs.vencimento.value),
          observacao: inputs.observacao.value.trim(),
          recorrente: recorrenteInput.checked,
        },
        accessToken
      );
      await refreshContas(tipo);
    } catch (err) {
      console.error(err);
      confirmBtn.disabled = false;
      statusEl.textContent = mensagemDoErro(err);
    }
  });
  panel.appendChild(confirmBtn);
  panel.appendChild(makeFornecedorActionButton("Cancelar", () => renderContaView(tipo, info, item)));

  info.appendChild(panel);
}

// --- Filter wiring, init, refresh --------------------------------------------

function setupContasFilterHandlers(tipo) {
  const p = idp(tipo);
  [`${p}-filtro-status`, `${p}-filtro-categoria`, `${p}-busca`].forEach((id) => {
    const el = document.getElementById(id);
    const evt = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(evt, () => renderContasList(tipo));
  });
}

let contasLookups = null;

function initContasList(tipo, items, lookups) {
  allContas[tipo] = items;
  contasLookups = lookups;
  populateContasFilterOptions(tipo, items);
  if (!contasFilterHandlersReady[tipo]) {
    setupContasFilterHandlers(tipo);
    contasFilterHandlersReady[tipo] = true;
  }
  renderContasList(tipo);
}

async function refreshContas(tipo) {
  const items = await fetchContas(tipo, accessToken);
  allContas[tipo] = items;
  populateContasFilterOptions(tipo, items);
  renderContasList(tipo);
}

// --- Nova conta form -----------------------------------------------------------

function resetContaForm(tipo) {
  document.getElementById(`${idp(tipo)}-form`).reset();
  document.getElementById(`${idp(tipo)}-field-vencimento`).value = new Date().toISOString().slice(0, 10);
}

function setupContaForm(tipo) {
  if (contasFormInitialized[tipo]) return;
  contasFormInitialized[tipo] = true;
  const p = idp(tipo);

  const form = document.getElementById(`${p}-form`);
  const formStatus = document.getElementById(`${p}-form-status`);
  const submitButton = document.getElementById(`btn-salvar-${p}`);

  resetContaForm(tipo);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const values = {
      descricao: document.getElementById(`${p}-field-descricao`).value.trim(),
      contraparte: document.getElementById(`${p}-field-contraparte`).value.trim(),
      categoria: document.getElementById(`${p}-field-categoria`).value.trim(),
      valor: document.getElementById(`${p}-field-valor`).value,
      vencimento: document.getElementById(`${p}-field-vencimento`).value,
      recorrente: document.getElementById(`${p}-field-recorrente`).checked,
      observacao: document.getElementById(`${p}-field-observacao`).value.trim(),
    };

    if (!values.descricao || !values.valor || Number(values.valor) <= 0 || !values.vencimento) {
      formStatus.textContent = "Preencha descrição, valor e vencimento.";
      return;
    }

    submitButton.disabled = true;
    formStatus.textContent = "Salvando...";
    try {
      const targetRow = await createConta(tipo, values, accessToken);
      formStatus.textContent = `Conta salva na linha ${targetRow}.`;
      resetContaForm(tipo);
      await refreshContas(tipo);
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueWrite(`conta-${tipo}-novo`, values);
        formStatus.textContent = "Sem internet — a conta foi guardada e será enviada automaticamente quando a conexão voltar.";
        resetContaForm(tipo);
      } else {
        console.error(err);
        formStatus.textContent = `Erro ao salvar: ${err.message}`;
      }
    } finally {
      submitButton.disabled = false;
    }
  });
}
