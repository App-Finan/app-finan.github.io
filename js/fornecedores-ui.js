let allFornecedores = [];
let fornecedoresFormInitialized = false;
let fornecedorEditingLinha = null;

// --- Filters -----------------------------------------------------------------

function populateFornecedoresFilterOptions(items) {
  const categorias = Array.from(new Set(items.map((f) => f.categoria).filter(Boolean))).sort();
  populateFilterSelect(document.getElementById("fornecedores-filtro-categoria"), categorias, "Todas as categorias");
  const datalist = document.getElementById("fornecedores-categorias-sugeridas");
  if (datalist) {
    datalist.innerHTML = "";
    categorias.forEach((categoria) => {
      const option = document.createElement("option");
      option.value = categoria;
      datalist.appendChild(option);
    });
  }
}

function getFornecedoresFilters() {
  return {
    categoria: document.getElementById("fornecedores-filtro-categoria").value,
    busca: document.getElementById("fornecedores-busca").value.trim().toLowerCase(),
    mostrarInativos: document.getElementById("fornecedores-mostrar-inativos").checked,
  };
}

function filterFornecedores(items, filters) {
  return items.filter((item) => {
    if (!filters.mostrarInativos && item.status === FORNECEDOR_STATUS_INATIVO) return false;
    if (filters.categoria && item.categoria !== filters.categoria) return false;
    if (filters.busca) {
      const haystack = [item.nome, item.documento, item.categoria, item.telefone, item.email, item.observacao]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.busca)) return false;
    }
    return true;
  });
}

// --- List rendering ------------------------------------------------------------

function renderFornecedoresList() {
  const filters = getFornecedoresFilters();
  const filtered = filterFornecedores(allFornecedores, filters);
  const container = document.getElementById("fornecedores-lista-container");
  container.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Nenhum fornecedor encontrado.";
    container.appendChild(empty);
    return;
  }

  filtered
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
    .forEach((item) => container.appendChild(buildFornecedorCard(item)));
}

function buildFornecedorCard(item) {
  const card = document.createElement("div");
  card.className = "fornecedor-card";
  card.dataset.linha = String(item.linha);

  const info = document.createElement("div");
  info.className = "fornecedor-info";
  card.appendChild(info);

  const statusBadge = document.createElement("span");
  statusBadge.className = `fornecedor-status fornecedor-status-${item.status === FORNECEDOR_STATUS_INATIVO ? "inativo" : "ativo"}`;
  statusBadge.textContent = item.status === FORNECEDOR_STATUS_INATIVO ? "Inativo" : "Ativo";
  card.appendChild(statusBadge);

  renderFornecedorView(info, item);

  return card;
}

function renderFornecedorView(info, item) {
  info.innerHTML = "";

  const title = document.createElement("div");
  title.className = "fornecedor-title";
  title.textContent = item.categoria ? `${item.nome} · ${item.categoria}` : item.nome;
  info.appendChild(title);

  const contatoParts = [item.documento, item.telefone, item.email].filter(Boolean);
  if (contatoParts.length > 0) {
    const contato = document.createElement("div");
    contato.className = "fornecedor-meta";
    contato.textContent = contatoParts.join(" · ");
    info.appendChild(contato);
  }

  if (item.prazoPagamento) {
    const prazo = document.createElement("div");
    prazo.className = "fornecedor-meta";
    prazo.textContent = `Prazo de pagamento: ${item.prazoPagamento}`;
    info.appendChild(prazo);
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
  renderFornecedorActions(actionsHost, item, info);
}

function makeFornecedorActionButton(label, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `fornecedor-action-btn${extraClass ? " " + extraClass : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderFornecedorActions(host, item, info) {
  host.innerHTML = "";
  if (!canEdit(currentUserRole)) return;

  const actions = document.createElement("div");
  actions.className = "fornecedor-actions";

  actions.appendChild(makeFornecedorActionButton("Editar", () => showFornecedorEditPanel(info, item)));

  if (item.status === FORNECEDOR_STATUS_INATIVO) {
    actions.appendChild(makeFornecedorActionButton("Reativar", () => handleFornecedorStatusChange(item, FORNECEDOR_STATUS_ATIVO)));
  } else {
    actions.appendChild(
      makeFornecedorActionButton("Inativar", () => {
        if (confirm(`Inativar "${item.nome}"? Ele deixa de aparecer nas listas, mas o histórico é mantido.`)) {
          handleFornecedorStatusChange(item, FORNECEDOR_STATUS_INATIVO);
        }
      })
    );
  }

  host.appendChild(actions);
}

async function handleFornecedorStatusChange(item, status) {
  try {
    await setFornecedorStatus(item, status, accessToken);
    await refreshFornecedores();
  } catch (err) {
    console.error(err);
    alert(describeSaveError(err));
  }
}

function showFornecedorEditPanel(info, item) {
  info.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "fornecedor-inline-panel";

  const fields = [
    { key: "nome", label: "Nome", value: item.nome, required: true },
    { key: "documento", label: "CNPJ/CPF", value: item.documento },
    { key: "categoria", label: "Categoria", value: item.categoria },
    { key: "telefone", label: "Telefone", value: item.telefone },
    { key: "email", label: "E-mail", value: item.email },
    { key: "prazoPagamento", label: "Prazo de pagamento", value: item.prazoPagamento },
    { key: "observacao", label: "Observação", value: item.observacao },
  ];

  const inputs = {};
  fields.forEach((field) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = field.label;
    input.value = field.value || "";
    inputs[field.key] = input;
    panel.appendChild(input);
  });

  const statusEl = document.createElement("span");
  statusEl.className = "status-message";
  panel.appendChild(statusEl);

  const confirmBtn = makeFornecedorActionButton("Salvar", async () => {
    const nome = inputs.nome.value.trim();
    if (!nome) {
      statusEl.textContent = "Informe o nome.";
      return;
    }
    confirmBtn.disabled = true;
    statusEl.textContent = "Salvando...";
    try {
      await updateFornecedor(
        item,
        {
          nome,
          documento: inputs.documento.value.trim(),
          categoria: inputs.categoria.value.trim(),
          telefone: inputs.telefone.value.trim(),
          email: inputs.email.value.trim(),
          prazoPagamento: inputs.prazoPagamento.value.trim(),
          observacao: inputs.observacao.value.trim(),
        },
        accessToken
      );
      await refreshFornecedores();
    } catch (err) {
      console.error(err);
      confirmBtn.disabled = false;
      statusEl.textContent = mensagemDoErro(err);
    }
  });
  panel.appendChild(confirmBtn);
  panel.appendChild(makeFornecedorActionButton("Cancelar", () => renderFornecedorView(info, item)));

  info.appendChild(panel);
}

// --- Filter wiring ---------------------------------------------------------

let fornecedoresFilterHandlersReady = false;

function setupFornecedoresFilterHandlers() {
  ["fornecedores-filtro-categoria", "fornecedores-busca", "fornecedores-mostrar-inativos"].forEach((id) => {
    const el = document.getElementById(id);
    const evt = el.type === "text" ? "input" : "change";
    el.addEventListener(evt, renderFornecedoresList);
  });
}

function initFornecedoresList(items) {
  allFornecedores = items;
  populateFornecedoresFilterOptions(items);
  if (!fornecedoresFilterHandlersReady) {
    setupFornecedoresFilterHandlers();
    fornecedoresFilterHandlersReady = true;
  }
  renderFornecedoresList();
}

async function refreshFornecedores() {
  const items = await fetchFornecedores(accessToken);
  allFornecedores = items;
  populateFornecedoresFilterOptions(items);
  renderFornecedoresList();
}

// --- Novo fornecedor form ----------------------------------------------------

function resetFornecedoresForm() {
  document.getElementById("fornecedores-form").reset();
}

function setupFornecedoresForm() {
  if (fornecedoresFormInitialized) return;
  fornecedoresFormInitialized = true;

  const form = document.getElementById("fornecedores-form");
  const formStatus = document.getElementById("fornecedores-form-status");
  const submitButton = document.getElementById("btn-salvar-fornecedor");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const values = {
      nome: document.getElementById("fornecedores-field-nome").value.trim(),
      documento: document.getElementById("fornecedores-field-documento").value.trim(),
      categoria: document.getElementById("fornecedores-field-categoria").value.trim(),
      telefone: document.getElementById("fornecedores-field-telefone").value.trim(),
      email: document.getElementById("fornecedores-field-email").value.trim(),
      prazoPagamento: document.getElementById("fornecedores-field-prazo").value.trim(),
      observacao: document.getElementById("fornecedores-field-observacao").value.trim(),
    };

    if (!values.nome) {
      formStatus.textContent = "Informe o nome do fornecedor.";
      return;
    }

    submitButton.disabled = true;
    formStatus.textContent = "Salvando...";
    try {
      const targetRow = await createFornecedor(values, accessToken);
      formStatus.textContent = `Fornecedor salvo na linha ${targetRow}.`;
      resetFornecedoresForm();
      await refreshFornecedores();
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueWrite("fornecedor-novo", values);
        formStatus.textContent = "Sem internet — o fornecedor foi guardado e será enviado automaticamente quando a conexão voltar.";
        resetFornecedoresForm();
      } else {
        console.error(err);
        formStatus.textContent = `Erro ao salvar: ${err.message}`;
      }
    } finally {
      submitButton.disabled = false;
    }
  });
}
