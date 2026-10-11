// "Baixar relatório" (2026-10-11): a PDF of the Dashboard's own numbers, for
// a weekly/monthly closing. Deliberately the simplest approach that needs no
// new dependency — a hidden, print-only container (#relatorio-impressao,
// index.html) filled fresh from already-loaded data, then window.print():
// the browser's own "Salvar como PDF" does the rest. No chart library, no
// PDF library — consistent with the rest of this app.
//
// Tables, not the Dashboard's own SVG charts: a plain table prints reliably
// in black-and-white, needs no hover (meaningless on paper), and is denser
// per A4 page — the same data every chart already exposes via its own
// "Ver tabela" toggle, just built directly here instead of reusing that UI.
//
// Scope, decided with the user: everything the Dashboard shows except
// "Atividade recente" (a live last-6-rows widget, not a period summary —
// the full ledger is already one CSV export away in Fluxo de Caixa).

function criarTabelaRelatorio(headers, rows) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function criarSecaoRelatorio(titulo) {
  const section = document.createElement("section");
  const h2 = document.createElement("h2");
  h2.textContent = titulo;
  section.appendChild(h2);
  return section;
}

function criarStatRelatorio(label, valor) {
  const stat = document.createElement("div");
  stat.className = "relatorio-stat";
  const labelEl = document.createElement("span");
  labelEl.className = "relatorio-stat-label";
  labelEl.textContent = label;
  const valorEl = document.createElement("span");
  valorEl.className = "relatorio-stat-valor";
  valorEl.textContent = valor;
  stat.appendChild(labelEl);
  stat.appendChild(valorEl);
  return stat;
}

function formatarDataCurta(date) {
  return date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function montarRelatorioImpressao() {
  const host = document.getElementById("relatorio-impressao");
  if (!host) return;
  host.innerHTML = "";

  const startInput = document.getElementById("filter-start").value;
  const endInput = document.getElementById("filter-end").value;
  const start = parseInputDate(startInput, false);
  const end = parseInputDate(endInput, true);
  const filtered = filterByDateRange(allLancamentos, start, end);

  // Header: empresa, período, when this snapshot was taken.
  const header = document.createElement("header");
  const titulo = document.createElement("h1");
  titulo.textContent = `Relatório financeiro — ${sidebarEmpresa.textContent}`;
  const periodo = document.createElement("p");
  periodo.className = "relatorio-periodo";
  periodo.textContent = `Período: ${formatarDataCurta(start)} a ${formatarDataCurta(end)}`;
  const geradoEm = document.createElement("p");
  geradoEm.className = "relatorio-gerado-em";
  geradoEm.textContent = `Gerado em ${new Date().toLocaleString("pt-BR")}`;
  header.appendChild(titulo);
  header.appendChild(periodo);
  header.appendChild(geradoEm);
  host.appendChild(header);

  // Resumo do período — the same numbers as the Dashboard's main KPI tiles.
  const kpis = computeKpis(filtered);
  const resumo = criarSecaoRelatorio("Resumo do período");
  const resumoStats = document.createElement("div");
  resumoStats.className = "relatorio-stats-row";
  resumoStats.appendChild(criarStatRelatorio("Saldo", formatBRL(kpis.saldo)));
  resumoStats.appendChild(criarStatRelatorio("Entradas", formatBRL(kpis.entradas)));
  resumoStats.appendChild(criarStatRelatorio("Saídas", formatBRL(kpis.saidas)));
  resumo.appendChild(resumoStats);
  // Same "only when relevant" rule as the Dashboard's own gold/quantity tiles
  // (js/dashboard.js's renderKpis) — a non-jewelry segment with no quantity
  // movement in the period doesn't get two empty "0" stats.
  if (vocab("kpiQuantidade") === "sempre" || kpis.pesoComprado > 0 || kpis.pesoVendido > 0) {
    const qtdStats = document.createElement("div");
    qtdStats.className = "relatorio-stats-row";
    qtdStats.appendChild(criarStatRelatorio(vocab("kpiCompra") + vocab("kpiCompraExtra"), formatQuantidade(kpis.pesoComprado)));
    qtdStats.appendChild(criarStatRelatorio(vocab("kpiVenda") + vocab("kpiVendaExtra"), formatQuantidade(kpis.pesoVendido)));
    resumo.appendChild(qtdStats);
  }
  host.appendChild(resumo);

  // Situação atual — Contas a Pagar/Receber, same as the Dashboard: not
  // scoped to the period above ("o que está pendente agora" has no period).
  const somarPendente = (items) =>
    (items || []).reduce((acc, i) => acc + (i.status === CONTAS_CONFIG[i.tipo].statusAberto ? i.valor || 0 : 0), 0);
  const situacao = criarSecaoRelatorio("Situação atual (contas pendentes)");
  const situacaoStats = document.createElement("div");
  situacaoStats.className = "relatorio-stats-row";
  situacaoStats.appendChild(criarStatRelatorio("Contas a Pagar", formatBRL(somarPendente(allContas.pagar))));
  situacaoStats.appendChild(criarStatRelatorio("Contas a Receber", formatBRL(somarPendente(allContas.receber))));
  situacao.appendChild(situacaoStats);
  host.appendChild(situacao);

  // Saldo por loja
  const porLoja = computeByLoja(filtered);
  const secaoLoja = criarSecaoRelatorio("Saldo por loja");
  secaoLoja.appendChild(
    criarTabelaRelatorio(
      ["Loja", "Entradas", "Saídas", "Saldo"],
      porLoja.map((l) => [l.loja, formatBRL(l.entradas), formatBRL(l.saidas), formatBRL(l.saldo)])
    )
  );
  host.appendChild(secaoLoja);

  // Entradas e saídas por mês
  const porMes = computeByMonth(filtered);
  const secaoMes = criarSecaoRelatorio("Entradas e saídas por mês");
  secaoMes.appendChild(
    criarTabelaRelatorio(
      ["Mês", "Entradas", "Saídas"],
      porMes.map((m) => [formatMonthLabel(m.mes), formatBRL(m.entradas), formatBRL(m.saidas)])
    )
  );
  host.appendChild(secaoMes);

  // Gastos por categoria (saída)
  const categoriasSaida = topNWithOthers(computeByCategoria(filtered, "Saída"), 10);
  const secaoSaida = criarSecaoRelatorio("Gastos por categoria");
  secaoSaida.appendChild(
    criarTabelaRelatorio(
      ["Categoria", "Valor"],
      categoriasSaida.map((c) => [c.categoria, formatBRL(c.valor)])
    )
  );
  host.appendChild(secaoSaida);

  // Maiores entradas por categoria
  const categoriasEntrada = topNWithOthers(computeByCategoria(filtered, "Entrada"), 10);
  const secaoEntrada = criarSecaoRelatorio("Maiores entradas por categoria");
  secaoEntrada.appendChild(
    criarTabelaRelatorio(
      ["Categoria", "Valor"],
      categoriasEntrada.map((c) => [c.categoria, formatBRL(c.valor)])
    )
  );
  host.appendChild(secaoEntrada);
}

function setupBaixarRelatorio() {
  const btn = document.getElementById("btn-baixar-relatorio");
  if (!btn) return;
  btn.addEventListener("click", () => {
    montarRelatorioImpressao();
    window.print();
  });
}

setupBaixarRelatorio();
