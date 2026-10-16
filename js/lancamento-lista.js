let lancamentoListaHandlersReady = false;

// Thousands of rows at once make phones sluggish, so show a page at a time.
const LANCAMENTO_LISTA_PAGE = 200;
let lancamentoListaLimit = LANCAMENTO_LISTA_PAGE;

function getLancamentoListaFilters() {
  return {
    start: parseInputDate(document.getElementById("lanc-lista-inicio").value, false),
    end: parseInputDate(document.getElementById("lanc-lista-fim").value, true),
    loja: document.getElementById("lanc-lista-loja").value,
    tipo: document.getElementById("lanc-lista-tipo").value,
    busca: document.getElementById("lanc-lista-busca").value.trim().toLowerCase(),
  };
}

function filterLancamentosLista(records, filters) {
  return records.filter((r) => {
    if (r.data && (r.data < filters.start || r.data > filters.end)) return false;
    if (filters.loja && r.loja !== filters.loja) return false;
    if (filters.tipo && r.tipo !== filters.tipo) return false;
    if (filters.busca) {
      const haystack = [r.categoria, r.pessoa, r.observacao, r.empresa, r.conta]
        .concat((r.extras || []).map((e) => String(e.valor)))
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.busca)) return false;
    }
    return true;
  });
}

function populateLancamentoListaFilterOptions(records) {
  const lojas = Array.from(new Set(records.map((r) => r.loja).filter(Boolean))).sort();
  populateFilterSelect(document.getElementById("lanc-lista-loja"), lojas, "Todas as lojas");
}

function formatLancamentoData(date) {
  return date ? date.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "";
}

const LANC_MAX_EXTRAS = 8;

// Names of the sheet's own extra columns (the ones the app has no field for),
// in the order they first appear.
function nomesDeExtras(records) {
  const nomes = [];
  records.forEach((r) => {
    (r.extras || []).forEach((e) => {
      if (nomes.indexOf(e.nome) === -1 && nomes.length < LANC_MAX_EXTRAS) nomes.push(e.nome);
    });
  });
  return nomes;
}

function valorDeExtra(record, nome) {
  const achado = (record.extras || []).filter((e) => e.nome === nome)[0];
  return achado ? String(achado.valor) : "";
}

// One card per lançamento (2026-10-16, replacing a literal spreadsheet-style
// table that showed every column — including ones empty for every row — as
// its own cell). Same visual language as .estoque-card/.fornecedor-card
// (reused directly, not re-cloned, same as Contas a Pagar/Receber already
// do — see css/style.css): a title line, a muted meta line that only ever
// joins the fields a given row actually has (nothing blank ever prints),
// and the value as a colored pill instead of a plain cell. The underlying
// data — js/lancamentos.js's fetch/parse and js/form.js's write path, which
// is what "alimenta a planilha" (feeds the sheet) — is untouched; this is a
// display-only change.
function buildLancamentoCard(r, nomesExtra) {
  const card = document.createElement("div");
  card.className = "fornecedor-card";
  card.dataset.linha = String(r.linha);

  const id = document.createElement("span");
  id.className = "estoque-id";
  id.textContent = `#${r.linha}`;
  card.appendChild(id);

  const info = document.createElement("div");
  info.className = "fornecedor-info";

  const title = document.createElement("div");
  title.className = "fornecedor-title";
  title.textContent = [formatLancamentoData(r.data), r.categoria].filter(Boolean).join(" · ");
  info.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "fornecedor-meta";
  const metaParts = [r.loja, r.conta, r.empresa, r.pessoa];
  if (r.peso != null) metaParts.push(formatQuantidade(r.peso));
  meta.textContent = metaParts.filter(Boolean).join(" · ");
  info.appendChild(meta);

  const extrasTexto = nomesExtra.map((nome) => valorDeExtra(r, nome)).filter(Boolean);
  if (extrasTexto.length) {
    const extrasEl = document.createElement("div");
    extrasEl.className = "fornecedor-meta";
    extrasEl.textContent = nomesExtra
      .map((nome) => (valorDeExtra(r, nome) ? `${nome}: ${valorDeExtra(r, nome)}` : null))
      .filter(Boolean)
      .join(" · ");
    info.appendChild(extrasEl);
  }

  if (r.observacao) {
    const obs = document.createElement("div");
    obs.className = "fornecedor-obs";
    obs.textContent = r.observacao;
    info.appendChild(obs);
  }

  card.appendChild(info);

  const valor = document.createElement("span");
  valor.className = `fornecedor-status ${r.tipo === "Entrada" ? "lanc-valor-entrada" : "lanc-valor-saida"}`;
  valor.textContent = formatBRL(r.valor);
  card.appendChild(valor);

  return card;
}

function renderLancamentoListaTable() {
  const nomesExtra = nomesDeExtras(allLancamentos);

  const filters = getLancamentoListaFilters();
  const filtered = filterLancamentosLista(allLancamentos, filters)
    .slice()
    .sort((a, b) => {
      const dataDiff = (b.data ? b.data.getTime() : 0) - (a.data ? a.data.getTime() : 0);
      return dataDiff !== 0 ? dataDiff : b.linha - a.linha;
    });

  const shown = Math.min(filtered.length, lancamentoListaLimit);
  document.getElementById("lancamento-lista-count").textContent =
    shown < filtered.length ? `${filtered.length} lançamento(s) — mostrando os ${shown} mais recentes` : `${filtered.length} lançamento(s)`;

  const moreButton = document.getElementById("lancamento-lista-mais");
  moreButton.hidden = shown >= filtered.length;
  moreButton.textContent = `Mostrar mais (${filtered.length - shown} restantes)`;

  const container = document.getElementById("lancamento-lista-container");
  container.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "Nenhum lançamento encontrado.";
    container.appendChild(empty);
    return;
  }

  filtered.slice(0, shown).forEach((r) => container.appendChild(buildLancamentoCard(r, nomesExtra)));
}

// A changed filter starts back at the first page.
function onLancamentoListaFilterChange() {
  lancamentoListaLimit = LANCAMENTO_LISTA_PAGE;
  renderLancamentoListaTable();
}

function setupLancamentoListaFilterHandlers() {
  ["lanc-lista-inicio", "lanc-lista-fim", "lanc-lista-loja", "lanc-lista-tipo"].forEach((id) => {
    document.getElementById(id).addEventListener("change", onLancamentoListaFilterChange);
  });
  document.getElementById("lanc-lista-busca").addEventListener("input", onLancamentoListaFilterChange);
  document.getElementById("lancamento-lista-mais").addEventListener("click", () => {
    lancamentoListaLimit += LANCAMENTO_LISTA_PAGE;
    renderLancamentoListaTable();
  });
  document.getElementById("lanc-lista-export-btn").addEventListener("click", exportLancamentosCsv);
}

function exportLancamentosCsv() {
  const filters = getLancamentoListaFilters();
  const filtered = filterLancamentosLista(allLancamentos, filters).slice().sort((a, b) => {
    const dataDiff = (b.data ? b.data.getTime() : 0) - (a.data ? a.data.getTime() : 0);
    return dataDiff !== 0 ? dataDiff : b.linha - a.linha;
  });

  const nomesExtra = nomesDeExtras(allLancamentos);
  const headers = [
    "#", "Data", "Loja", "Conta", "Empresa", "Categoria", "Valor", "Tipo", vocab("qtdRotulo"), "Pessoa", "Observação",
  ].concat(nomesExtra);

  const rows = filtered.map((r) => [
    r.linha,
    formatLancamentoData(r.data),
    r.loja || "",
    r.conta || "",
    r.empresa || "",
    r.categoria || "",
    r.valor ?? "",
    r.tipo || "",
    r.peso ?? "",
    r.pessoa || "",
    r.observacao || "",
  ].concat(nomesExtra.map((nome) => valorDeExtra(r, nome))));

  downloadCsv(`lancamentos_${todayForFilename()}.csv`, headers, rows);
}

function initLancamentoLista(records) {
  populateLancamentoListaFilterOptions(records);
  if (!lancamentoListaHandlersReady) {
    setupLancamentoListaFilterHandlers();
    lancamentoListaHandlersReady = true;
  }
  const { start, end } = computePresetRange("tudo", records);
  document.getElementById("lanc-lista-inicio").value = toInputDateValue(start);
  document.getElementById("lanc-lista-fim").value = toInputDateValue(end);
  lancamentoListaLimit = LANCAMENTO_LISTA_PAGE;
  renderLancamentoListaTable();
}
