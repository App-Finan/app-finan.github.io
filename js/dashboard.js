let allLancamentos = [];

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function startOfMonthUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonthUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function toInputDateValue(date) {
  return date.toISOString().slice(0, 10);
}

function parseInputDate(value, endOfDay) {
  return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
}

function computePresetRange(preset, records) {
  const today = new Date();
  const now = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  switch (preset) {
    case "mes-atual":
      return { start: startOfMonthUTC(now), end: endOfMonthUTC(now) };
    case "mes-anterior": {
      const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      return { start: startOfMonthUTC(prevMonth), end: endOfMonthUTC(prevMonth) };
    }
    case "ano-atual":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), 11, 31)),
      };
    case "tudo":
    default: {
      const dates = records.map((r) => r.data).filter(Boolean);
      if (dates.length === 0) return { start: startOfMonthUTC(now), end: endOfMonthUTC(now) };
      return {
        start: new Date(Math.min(...dates)),
        end: new Date(Math.max(...dates)),
      };
    }
  }
}

// Fixed, developer-authored icon markup only (never sheet/user data) — safe
// to insert as innerHTML; see the no-innerHTML-with-untrusted-data rule this
// deliberately doesn't violate (CLAUDE.md's Security posture section).
const KPI_ICONS = {
  up: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  scale: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
};

// One small icon per segment for the quantity tiles. Fixed developer-authored
// strings, picked by a whitelisted segment id (never built from data).
const ICONES_SEGMENTO = {
  joalheria: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
  petshop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="10" r="2"/><circle cx="10" cy="5.5" r="2"/><circle cx="15" cy="5.5" r="2"/><circle cx="19" cy="10" r="2"/><path d="M12 12c-3 0-6 3-6 5.5 0 2 1.7 2.7 3.2 2.3 1-.3 1.8-.6 2.8-.6s1.8.3 2.8.6c1.5.4 3.2-.3 3.2-2.3 0-2.5-3-5.5-6-5.5z"/></svg>',
  comercio: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 9h14v11H5z"/><path d="M9 9V6h6v3"/></svg>',
  servicos: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 9l3 1.7v3.4L12 15.8 9 14.1v-3.4z"/></svg>',
  alimentacao: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/></svg>',
  saude: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z"/></svg>',
  outro: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
};

function iconeDoSegmento() {
  return ICONES_SEGMENTO[segmentoValido(segmentoAtual)];
}

// null when there's no meaningful baseline (no previous-period data, or it
// was zero) — the caller skips rendering a trend line rather than showing a
// fake/divide-by-zero percentage.
function computeTrend(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// Tiny line chart drawn from real series values. Needs at least 2 points.
function buildSparkline(values, filled) {
  if (!values || values.length < 2) return null;
  const width = 200;
  const height = 60;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => [
    (i / (values.length - 1)) * width,
    height - 4 - ((v - min) / range) * (height - 8),
  ]);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
  svg.setAttribute("class", "stat-spark");
  if (filled) {
    svg.appendChild(
      svgNode("polygon", {
        points: `0,${height} ${points.map((p) => p.join(",")).join(" ")} ${width},${height}`,
        class: "stat-spark-fill",
      })
    );
  }
  svg.appendChild(svgNode("polyline", { points: points.map((p) => p.join(",")).join(" "), class: "stat-spark-line", "vector-effect": "non-scaling-stroke" }));
  return svg;
}

function buildKpiTile({ label, labelExtra, value, icon, iconClass, trend, hero, invertTrendColor, spark, art }) {
  const tile = document.createElement("div");
  tile.className = `stat-tile${hero ? " stat-tile-hero" : ""}`;

  const top = document.createElement("div");
  top.className = "stat-top";

  const labelEl = document.createElement("span");
  labelEl.className = "stat-label";
  labelEl.textContent = label;
  if (labelExtra) {
    // Qualifier hidden on narrow screens so every tile's label fits one line.
    const extraEl = document.createElement("span");
    extraEl.className = "stat-label-extra";
    extraEl.textContent = labelExtra;
    labelEl.appendChild(extraEl);
  }

  const iconBadge = document.createElement("div");
  iconBadge.className = `stat-icon stat-icon-${iconClass}`;
  iconBadge.innerHTML = icon;

  top.appendChild(labelEl);
  top.appendChild(iconBadge);

  const valueEl = document.createElement("div");
  valueEl.className = "stat-value";
  valueEl.textContent = value;

  if (art) {
    const artSlot = document.createElement("div");
    artSlot.className = `stat-art stat-art-${art}`;
    artSlot.appendChild(art === "hero" ? buildHeroArt() : buildSegmentArt(segmentoAtual));
    tile.appendChild(artSlot);
  }

  tile.appendChild(top);
  tile.appendChild(valueEl);

  if (trend !== null && trend !== undefined) {
    // The arrow/percentage always reflect the real change. The color reflects
    // whether that change is favorable for this specific metric — for a
    // "cost" metric like Saídas, a drop (trend < 0) is the good outcome and
    // should read green, not red, so it's inverted via `invertTrendColor`
    // rather than tying color straight to the raw sign.
    const isUp = trend >= 0;
    const isFavorable = invertTrendColor ? !isUp : isUp;
    const trendEl = document.createElement("div");
    trendEl.className = `stat-trend ${isFavorable ? "positive" : "negative"}`;
    // A near-zero previous period (common for Saldo) makes the percentage
    // absurd (e.g. 53818604.9%) — cap the display instead of showing noise.
    const pct = Math.abs(trend);
    trendEl.textContent = `${isUp ? "↑" : "↓"} ${pct >= 1000 ? "999%+" : pct.toFixed(1) + "%"}`;
    const refEl = document.createElement("span");
    refEl.className = "stat-trend-ref";
    refEl.textContent = " vs. período anterior";
    trendEl.appendChild(refEl);
    tile.appendChild(trendEl);
  }

  const sparkSvg = spark ? buildSparkline(spark.values, spark.filled) : null;
  if (sparkSvg) {
    const sparkSlot = document.createElement("div");
    sparkSlot.className = `stat-spark-slot${spark.filled ? " stat-spark-slot-wide" : ""}`;
    if (spark.tone) sparkSlot.classList.add(`stat-spark-${spark.tone}`);
    sparkSlot.appendChild(sparkSvg);
    tile.appendChild(sparkSlot);
  }

  return tile;
}

function renderKpis(records, prevRecords, series) {
  const kpis = computeKpis(records);
  const prevKpis = prevRecords && prevRecords.length > 0 ? computeKpis(prevRecords) : null;
  const trendFor = (curr, key) => (prevKpis ? computeTrend(curr, prevKpis[key]) : null);

  const kpiRow = document.getElementById("kpi-row");
  kpiRow.innerHTML = "";

  kpiRow.appendChild(
    buildKpiTile({
      label: "Entradas",
      labelExtra: " do período",
      value: formatBRL(kpis.entradas),
      icon: KPI_ICONS.up,
      iconClass: "success",
      trend: trendFor(kpis.entradas, "entradas"),
      spark: series ? { values: series.entradas, tone: "accent" } : null,
    })
  );
  kpiRow.appendChild(
    buildKpiTile({
      label: "Saídas",
      labelExtra: " do período",
      value: formatBRL(kpis.saidas),
      icon: KPI_ICONS.down,
      iconClass: "danger",
      trend: trendFor(kpis.saidas, "saidas"),
      invertTrendColor: true,
      spark: series ? { values: series.saidas, tone: "accent" } : null,
    })
  );
  kpiRow.appendChild(
    buildKpiTile({
      label: "Saldo",
      labelExtra: " do período",
      value: formatBRL(kpis.saldo),
      icon: KPI_ICONS.scale,
      iconClass: "hero",
      hero: true,
      art: "hero",
      trend: trendFor(kpis.saldo, "saldo"),
      spark: series ? { values: series.saldo, filled: true, tone: "accent" } : null,
    })
  );
  const showQuantidade = vocab("kpiQuantidade") === "sempre" || kpis.pesoComprado > 0 || kpis.pesoVendido > 0;
  if (!showQuantidade) return;
  kpiRow.appendChild(
    buildKpiTile({
      label: vocab("kpiCompra"),
      labelExtra: vocab("kpiCompraExtra"),
      value: formatQuantidade(kpis.pesoComprado),
      icon: iconeDoSegmento(),
      iconClass: "neutral",
      art: "ingot",
      trend: trendFor(kpis.pesoComprado, "pesoComprado"),
    })
  );
  kpiRow.appendChild(
    buildKpiTile({
      label: vocab("kpiVenda"),
      labelExtra: vocab("kpiVendaExtra"),
      value: formatQuantidade(kpis.pesoVendido),
      icon: iconeDoSegmento(),
      iconClass: "neutral",
      art: "ingot",
      trend: trendFor(kpis.pesoVendido, "pesoVendido"),
    })
  );
}

// "Contas a Pagar"/"Contas a Receber", as plain numbers next to Entradas/
// Saídas (requested 2026-10-11) — reuses the exact .conta-kpi card the Contas
// a Pagar/Receber screens already use for their own "Pendente" stat, rather
// than the heavier KPI-tile system (icon/trend/sparkline) those screens'
// numbers don't have either. Deliberately NOT scoped to the dashboard's date
// filter: unlike a period's entradas/saídas, "what's currently owed" has no
// period of its own, so this renders once when the data loads/refreshes, not
// on every filter change renderDashboardCharts triggers.
function renderContasResumoDashboard(pagarItems, receberItems) {
  const host = document.getElementById("dashboard-contas-kpis");
  if (!host) return;
  host.innerHTML = "";
  const somarPendente = (items) =>
    (items || []).reduce((acc, i) => acc + (i.status === CONTAS_CONFIG[i.tipo].statusAberto ? i.valor || 0 : 0), 0);
  // Same buildKpiTile the other tiles use (2026-10-11: the lighter .conta-kpi
  // card — same one Contas a Pagar/Receber's own list screens use — looked
  // visually empty/small next to the full-size tiles above it). No
  // trend/spark/art, so it stays "só números" as asked; the icon alone
  // (mirroring Entradas=up/success, Saídas=down/danger) is enough to fill a
  // normal .stat-tile's height without inventing fake trend data.
  host.appendChild(
    buildKpiTile({ label: "Contas a Pagar", value: formatBRL(somarPendente(pagarItems)), icon: KPI_ICONS.down, iconClass: "danger" })
  );
  host.appendChild(
    buildKpiTile({ label: "Contas a Receber", value: formatBRL(somarPendente(receberItems)), icon: KPI_ICONS.up, iconClass: "success" })
  );
}

function chartBody(cardId) {
  return document.querySelector(`#${cardId} .chart-body`);
}

// Fixed, developer-authored icon markup only — same non-dynamic-innerHTML
// exception as KPI_ICONS above.
const ACTIVITY_ICONS = {
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
};

// Real transaction dates only — the sheet has no "entered at" timestamp, so
// this deliberately does not fabricate relative times like "12 min atrás".
function renderAtividadeRecente(records) {
  const container = document.getElementById("atividade-recente-lista");
  if (!container) return;
  container.innerHTML = "";

  const recent = records
    .slice()
    .sort((a, b) => {
      const dataDiff = (b.data ? b.data.getTime() : 0) - (a.data ? a.data.getTime() : 0);
      return dataDiff !== 0 ? dataDiff : b.linha - a.linha;
    })
    .slice(0, 6);

  if (recent.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "Sem lançamentos no período.";
    container.appendChild(empty);
    return;
  }

  recent.forEach((r) => {
    const isEntrada = r.tipo === "Entrada";
    const row = document.createElement("div");
    row.className = "activity-row";

    const icon = document.createElement("div");
    icon.className = `activity-icon ${isEntrada ? "success" : "danger"}`;
    icon.innerHTML = isEntrada ? ACTIVITY_ICONS.up : ACTIVITY_ICONS.down;
    row.appendChild(icon);

    const info = document.createElement("div");
    info.className = "activity-info";

    const title = document.createElement("div");
    title.className = "activity-title";
    title.textContent = [r.categoria, r.pessoa].filter(Boolean).join(" — ") || "Lançamento";
    info.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    const metaParts = [r.loja, r.data ? r.data.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : null].filter(Boolean);
    meta.textContent = metaParts.join(" · ");
    info.appendChild(meta);

    row.appendChild(info);

    const amount = document.createElement("div");
    amount.className = `activity-amount ${isEntrada ? "positive" : "negative"}`;
    amount.textContent = `${isEntrada ? "+" : "−"}${formatBRL(Math.abs(r.valor))}`;
    row.appendChild(amount);

    container.appendChild(row);
  });
}

let activitySeeAllReady = false;

function setupActivitySeeAll() {
  if (activitySeeAllReady) return;
  activitySeeAllReady = true;
  const btn = document.querySelector(".activity-see-all");
  if (btn) btn.addEventListener("click", () => setActiveView(btn.dataset.view));
}

function renderDashboardCharts() {
  const startInput = document.getElementById("filter-start").value;
  const endInput = document.getElementById("filter-end").value;
  if (!startInput || !endInput) return;

  const start = parseInputDate(startInput, false);
  const end = parseInputDate(endInput, true);
  const filtered = filterByDateRange(allLancamentos, start, end);

  // Same-length window immediately preceding the selected range, used for
  // the KPI trend indicators ("↑ 12% vs. período anterior") — a real
  // comparison, not a decorative fixed number.
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 1000);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  const prevFiltered = filterByDateRange(allLancamentos, prevStart, prevEnd);

  renderKpis(filtered, prevFiltered, computeSeries(filtered, start, end));
  renderAtividadeRecente(filtered);
  renderDivergingBarChart(chartBody("chart-saldo-loja"), computeByLoja(filtered));
  renderMonthlyGroupedChart(chartBody("chart-mensal"), computeByMonth(filtered));
  renderDonutChart(chartBody("chart-pizza-saidas"), topNWithOthers(computeByCategoria(filtered, "Saída"), 5));
  renderDonutChart(chartBody("chart-pizza-entradas"), topNWithOthers(computeByCategoria(filtered, "Entrada"), 5));
}

function setActivePreset(preset) {
  document.querySelectorAll(".filter-presets button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === preset);
  });
}

function applyPreset(preset) {
  const { start, end } = computePresetRange(preset, allLancamentos);
  document.getElementById("filter-start").value = toInputDateValue(start);
  document.getElementById("filter-end").value = toInputDateValue(end);
  setActivePreset(preset);
  renderDashboardCharts();
}

function setupFilterHandlers() {
  document.querySelectorAll(".filter-presets button").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  ["filter-start", "filter-end"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      setActivePreset(null);
      renderDashboardCharts();
    });
  });

  window.addEventListener("resize", debounce(renderDashboardCharts, 200));
}

function initDashboard(records) {
  allLancamentos = records;
  document.getElementById("dashboard").hidden = false;
  setupFilterHandlers();
  setupActivitySeeAll();
  applyPreset("mes-atual");
}

// Refresh the underlying data without resetting the user's current filter/preset.
function updateLancamentos(records) {
  allLancamentos = records;
  renderDashboardCharts();
}
