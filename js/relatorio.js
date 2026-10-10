// ERP, Fase 1 — a simple DRE ("resultado"): entradas, saídas, saldo and a
// ranked-by-category breakdown, over the same date range controls as the
// Dashboard. Deliberately thin: it reuses the Dashboard's own data
// (allLancamentos, js/dashboard.js) and aggregation/chart functions
// (js/dashboard-data.js, js/charts.js) rather than re-fetching or
// re-implementing anything — one source of truth for "what the ledger says."
let relatorioInitialized = false;

function relatorioStatCard(label, valor, destaque) {
  const card = document.createElement("div");
  card.className = "card";
  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;
  const valorEl = document.createElement("div");
  valorEl.className = "conta-kpi-valor" + (destaque ? " conta-kpi-alerta" : "");
  valorEl.textContent = formatBRL(valor);
  card.appendChild(labelEl);
  card.appendChild(valorEl);
  return card;
}

function renderRelatorio() {
  const start = parseInputDate(document.getElementById("relatorio-inicio").value, false);
  const end = parseInputDate(document.getElementById("relatorio-fim").value, true);
  const filtered = start && end ? filterByDateRange(allLancamentos, start, end) : allLancamentos;

  const kpis = computeKpis(filtered);
  const host = document.getElementById("relatorio-kpi-row");
  host.innerHTML = "";
  host.appendChild(relatorioStatCard("Entradas", kpis.entradas, false));
  host.appendChild(relatorioStatCard("Saídas", kpis.saidas, true));
  host.appendChild(relatorioStatCard("Resultado", kpis.saldo, false));

  // Saídas only, same as the Dashboard's own "Gastos por categoria" — "where
  // the money went" is the question a simple result report answers first.
  renderRankedBarChart(chartBody("relatorio-chart-categorias"), topNWithOthers(computeByCategoria(filtered, "Saída"), 10));
}

function applyRelatorioPreset(preset) {
  const { start, end } = computePresetRange(preset, allLancamentos);
  document.getElementById("relatorio-inicio").value = toInputDateValue(start);
  document.getElementById("relatorio-fim").value = toInputDateValue(end);
  document.querySelectorAll(".relatorio-presets button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.relatorioPreset === preset);
  });
  renderRelatorio();
}

function setupRelatorio() {
  if (relatorioInitialized) return;
  relatorioInitialized = true;

  document.querySelectorAll(".relatorio-presets button").forEach((btn) => {
    btn.addEventListener("click", () => applyRelatorioPreset(btn.dataset.relatorioPreset));
  });
  ["relatorio-inicio", "relatorio-fim"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      document.querySelectorAll(".relatorio-presets button").forEach((btn) => btn.classList.remove("active"));
      renderRelatorio();
    });
  });
  window.addEventListener("resize", debounce(() => {
    if (!document.getElementById("view-relatorio").hidden) renderRelatorio();
  }, 200));

  applyRelatorioPreset("mes-atual");
}
