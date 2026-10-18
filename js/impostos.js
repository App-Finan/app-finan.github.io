// Financeiro → Impostos (2026-10-17). An APPROXIMATE tax calculator, not an
// official one — every result shown here must be read as an estimate, never
// as a real guia/declaração. Built after the user explicitly asked to plan
// the paths first (see CLAUDE.md "Fase 2 — contabilidade"), then chose: all
// four regimes, access for Editor+Master (not Visualizador), faturamento
// informed by hand every month (not pulled from Lançamento), a detailed
// per-tax breakdown, Simples Nacional's Anexo picked directly (no Fator R),
// and ICMS/ISS rates informed by hand (they vary per state/município and
// there is no reliable single source for every rate in Brazil).
//
// Two kinds of data, deliberately split:
// - Configuração (persisted, one row in the "Configuração Tributária" tab,
//   Editor+Master only — see IMPOSTOS_TAB in apps-script/Code.gs): the
//   company's tax STRUCTURE, which rarely changes (regime, atividade, Anexo,
//   UF/município, alíquotas de ICMS/ISS, a partilha do DAS, os valores fixos
//   do MEI).
// - Calculadora (never persisted, typed fresh every time — confirmed with
//   the user): faturamento do mês, RBT12, lucro apurado. Pure client-side
//   math, no network call for the calculation itself.
//
// The Simples Nacional bracket thresholds/alíquotas/deduções below come from
// LC 123/2006 as amended by LC 155/2017 (in force since Jan/2018) — widely
// published and stable since then, but a tax reform transition (IBS/CBS
// replacing PIS/COFINS) runs 2026–2033, so these numbers can change under
// this feature's feet. The DAS "partilha" (how the single DAS payment splits
// across IRPJ/CSLL/COFINS/PIS/CPP/ICMS-ou-ISS) varies by Anexo AND by faixa,
// and even official-looking secondary sources disagree on the exact split —
// so, deliberately, this tool does NOT hardcode a partilha table. Instead the
// Master/Editor types in their own Anexo+faixa's published percentages (see
// the config form) and the tool just does the arithmetic. ALWAYS confirm
// every number here with the Portal do Simples Nacional / Receita Federal /
// the company's accountant before using it for a real decision.
const IMPOSTOS_SHEET_NAME = "Configuração Tributária";
const IMPOSTOS_HEADERS = [
  "Regime", "Atividade", "Anexo Simples", "UF", "Município", "Alíquota ICMS (%)", "Alíquota ISS (%)",
  "Partilha IRPJ (%)", "Partilha CSLL (%)", "Partilha COFINS (%)", "Partilha PIS (%)", "Partilha CPP (%)", "Partilha ICMS/ISS (%)",
  "MEI INSS fixo (R$)", "MEI ICMS fixo (R$)", "MEI ISS fixo (R$)", "Atualizado em",
];
let impostosConfigReady = false;

// RBT12 (faturamento dos últimos 12 meses) faixas — as mesmas 6 faixas valem
// para todos os Anexos, só a alíquota nominal e a dedução mudam por Anexo.
const SIMPLES_FAIXAS_RBT12 = [180000, 360000, 720000, 1800000, 3600000, 4800000];

// { aliquota: % nominal da faixa, deducao: valor fixo em R$ a deduzir }.
const SIMPLES_ANEXOS = {
  I: [
    { aliquota: 4.0, deducao: 0 },
    { aliquota: 7.3, deducao: 5940 },
    { aliquota: 9.5, deducao: 13860 },
    { aliquota: 10.7, deducao: 22500 },
    { aliquota: 14.3, deducao: 87300 },
    { aliquota: 19.0, deducao: 378000 },
  ],
  II: [
    { aliquota: 4.5, deducao: 0 },
    { aliquota: 7.8, deducao: 5940 },
    { aliquota: 10.0, deducao: 13860 },
    { aliquota: 11.2, deducao: 22500 },
    { aliquota: 14.7, deducao: 85500 },
    { aliquota: 30.0, deducao: 720000 },
  ],
  III: [
    { aliquota: 6.0, deducao: 0 },
    { aliquota: 11.2, deducao: 9360 },
    { aliquota: 13.5, deducao: 17640 },
    { aliquota: 16.0, deducao: 35640 },
    { aliquota: 21.0, deducao: 125640 },
    { aliquota: 33.0, deducao: 648000 },
  ],
  IV: [
    { aliquota: 4.5, deducao: 0 },
    { aliquota: 9.0, deducao: 8100 },
    { aliquota: 10.2, deducao: 12420 },
    { aliquota: 14.0, deducao: 39780 },
    { aliquota: 22.0, deducao: 183780 },
    { aliquota: 33.0, deducao: 828000 },
  ],
  V: [
    { aliquota: 15.5, deducao: 0 },
    { aliquota: 18.0, deducao: 4500 },
    { aliquota: 19.5, deducao: 9900 },
    { aliquota: 20.5, deducao: 17100 },
    { aliquota: 23.0, deducao: 62100 },
    { aliquota: 30.5, deducao: 540000 },
  ],
};

// Lucro Presumido: percentuais de presunção fixados em lei (regra geral —
// há percentuais menores para algumas atividades específicas, como revenda
// de combustíveis ou transporte de cargas, não cobertos aqui).
const PRESUNCAO_IRPJ = { "Comércio": 0.08, "Indústria": 0.08, "Serviço": 0.32, "Comércio e Serviço": 0.08 };
const PRESUNCAO_CSLL = { "Comércio": 0.12, "Indústria": 0.12, "Serviço": 0.32, "Comércio e Serviço": 0.12 };
const ADICIONAL_IRPJ_LIMITE_MES = 20000; // limite mensal simplificado do adicional de 10% (a regra oficial é trimestral)

function calcularSimplesNacional(rbt12, faturamentoMes, anexo) {
  const tabela = SIMPLES_ANEXOS[anexo] || SIMPLES_ANEXOS.I;
  let faixaIndex = SIMPLES_FAIXAS_RBT12.findIndex((limite) => rbt12 <= limite);
  if (faixaIndex === -1) faixaIndex = tabela.length - 1;
  const faixa = tabela[faixaIndex];
  const aliquotaEfetiva = rbt12 > 0 ? Math.max(0, (rbt12 * (faixa.aliquota / 100) - faixa.deducao) / rbt12) : faixa.aliquota / 100;
  const dasTotal = aliquotaEfetiva * faturamentoMes;
  return { aliquotaNominal: faixa.aliquota, deducao: faixa.deducao, aliquotaEfetiva, dasTotal, faixaIndex };
}

function calcularLucroPresumido({ faturamentoMes, atividade, aliquotaIcms, aliquotaIss }) {
  const presuncaoIrpj = PRESUNCAO_IRPJ[atividade] || PRESUNCAO_IRPJ["Comércio"];
  const presuncaoCsll = PRESUNCAO_CSLL[atividade] || PRESUNCAO_CSLL["Comércio"];
  const baseIrpj = faturamentoMes * presuncaoIrpj;
  const baseCsll = faturamentoMes * presuncaoCsll;
  const irpj = baseIrpj * 0.15 + Math.max(0, baseIrpj - ADICIONAL_IRPJ_LIMITE_MES) * 0.1;
  const csll = baseCsll * 0.09;
  const pis = faturamentoMes * 0.0065;
  const cofins = faturamentoMes * 0.03;
  const icms = (atividade === "Comércio" || atividade === "Indústria" || atividade === "Comércio e Serviço") ? faturamentoMes * ((aliquotaIcms || 0) / 100) : 0;
  const iss = (atividade === "Serviço" || atividade === "Comércio e Serviço") ? faturamentoMes * ((aliquotaIss || 0) / 100) : 0;
  return { irpj, csll, pis, cofins, icms, iss, total: irpj + csll + pis + cofins + icms + iss };
}

function calcularLucroReal({ faturamentoMes, lucroApurado, atividade, aliquotaIcms, aliquotaIss }) {
  const irpj = lucroApurado * 0.15 + Math.max(0, lucroApurado - ADICIONAL_IRPJ_LIMITE_MES) * 0.1;
  const csll = lucroApurado * 0.09;
  // PIS/COFINS não-cumulativos, sem considerar créditos de insumos — uma
  // simplificação intencional (o app não tem os dados de despesas dedutíveis
  // necessários para apurar o crédito real).
  const pis = faturamentoMes * 0.0165;
  const cofins = faturamentoMes * 0.076;
  const icms = (atividade === "Comércio" || atividade === "Indústria" || atividade === "Comércio e Serviço") ? faturamentoMes * ((aliquotaIcms || 0) / 100) : 0;
  const iss = (atividade === "Serviço" || atividade === "Comércio e Serviço") ? faturamentoMes * ((aliquotaIss || 0) / 100) : 0;
  return { irpj, csll, pis, cofins, icms, iss, total: irpj + csll + pis + cofins + icms + iss };
}

function calcularMei({ atividade, meiInss, meiIcms, meiIss }) {
  const inss = meiInss || 0;
  const icms = (atividade === "Comércio" || atividade === "Indústria" || atividade === "Comércio e Serviço") ? (meiIcms || 0) : 0;
  const iss = (atividade === "Serviço" || atividade === "Comércio e Serviço") ? (meiIss || 0) : 0;
  return { inss, icms, iss, total: inss + icms + iss };
}

// ---------------------------------------------------------------------------
// Persistência da configuração (uma linha fixa, A2:Q2)
// ---------------------------------------------------------------------------

async function ensureImpostosSheet(token) {
  try {
    const titles = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    if (!titles.includes(IMPOSTOS_SHEET_NAME)) {
      await createSheetTab(CONFIG.SPREADSHEET_ID, IMPOSTOS_SHEET_NAME, token);
      await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${IMPOSTOS_SHEET_NAME}'!A1:Q1`, IMPOSTOS_HEADERS, token);
    }
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
  }
}

function parseImpostosRow(row) {
  const num = (v) => (v === "" || v === undefined || v === null ? "" : String(v));
  return {
    regime: row[0] ? String(row[0]) : "Simples Nacional",
    atividade: row[1] ? String(row[1]) : "Comércio",
    anexo: row[2] ? String(row[2]) : "I",
    uf: num(row[3]),
    municipio: num(row[4]),
    aliquotaIcms: num(row[5]),
    aliquotaIss: num(row[6]),
    partilhaIrpj: num(row[7]),
    partilhaCsll: num(row[8]),
    partilhaCofins: num(row[9]),
    partilhaPis: num(row[10]),
    partilhaCpp: num(row[11]),
    partilhaIcmsIss: num(row[12]),
    meiInss: num(row[13]),
    meiIcms: num(row[14]),
    meiIss: num(row[15]),
    atualizadoEm: num(row[16]),
  };
}

async function fetchImpostosConfig(token) {
  try {
    const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${IMPOSTOS_SHEET_NAME}'!A2:Q2`, token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    if (!rows.length || !rows[0].some((v) => v !== "" && v !== undefined && v !== null)) return null;
    return parseImpostosRow(rows[0]);
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    return null;
  }
}

async function saveImpostosConfig(values, token) {
  const row = [
    values.regime || "Simples Nacional",
    values.atividade || "Comércio",
    values.anexo || "I",
    values.uf || "",
    values.municipio || "",
    values.aliquotaIcms || "",
    values.aliquotaIss || "",
    values.partilhaIrpj || "",
    values.partilhaCsll || "",
    values.partilhaCofins || "",
    values.partilhaPis || "",
    values.partilhaCpp || "",
    values.partilhaIcmsIss || "",
    values.meiInss || "",
    values.meiIcms || "",
    values.meiIss || "",
    new Date().toLocaleString("pt-BR"),
  ];
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${IMPOSTOS_SHEET_NAME}'!A2:Q2`, row, token);
}

// ---------------------------------------------------------------------------
// Tela: configuração + calculadora
// ---------------------------------------------------------------------------

function impostosConfigStatus(message) {
  const el = document.getElementById("impostos-config-status");
  if (el) {
    el.textContent = message || "";
    el.classList.toggle("status-erro", /^Erro/.test(message || ""));
  }
}

// Mostra só os campos que fazem sentido para o regime/atividade escolhidos —
// nunca um campo que o cálculo daquele regime nem usa.
function atualizarCamposImpostos() {
  const regime = document.getElementById("impostos-regime").value;
  const atividade = document.getElementById("impostos-atividade").value;
  const simples = regime === "Simples Nacional";
  const presumidoOuReal = regime === "Lucro Presumido" || regime === "Lucro Real";
  const mei = regime === "MEI";
  const temIcms = atividade === "Comércio" || atividade === "Indústria" || atividade === "Comércio e Serviço";
  const temIss = atividade === "Serviço" || atividade === "Comércio e Serviço";

  document.getElementById("impostos-anexo-campo").hidden = !simples;
  document.getElementById("impostos-partilha-hint").hidden = !simples;
  document.getElementById("impostos-partilha-grid").hidden = !simples;
  document.getElementById("impostos-icms-campo").hidden = !(presumidoOuReal && temIcms);
  document.getElementById("impostos-iss-campo").hidden = !(presumidoOuReal && temIss);
  document.getElementById("impostos-mei-grid").hidden = !mei;
  document.getElementById("impostos-mei-icms-campo").hidden = !(mei && temIcms);
  document.getElementById("impostos-mei-iss-campo").hidden = !(mei && temIss);

  document.getElementById("impostos-calc-rbt12-campo").hidden = !simples;
  document.getElementById("impostos-calc-lucro-campo").hidden = regime !== "Lucro Real";
}

function preencherImpostosConfig(cfg) {
  const c = cfg || {};
  document.getElementById("impostos-regime").value = c.regime || "Simples Nacional";
  document.getElementById("impostos-atividade").value = c.atividade || "Comércio";
  document.getElementById("impostos-anexo").value = c.anexo || "I";
  document.getElementById("impostos-uf").value = c.uf || "";
  document.getElementById("impostos-municipio").value = c.municipio || "";
  document.getElementById("impostos-aliquota-icms").value = c.aliquotaIcms || "";
  document.getElementById("impostos-aliquota-iss").value = c.aliquotaIss || "";
  document.getElementById("impostos-partilha-irpj").value = c.partilhaIrpj || "";
  document.getElementById("impostos-partilha-csll").value = c.partilhaCsll || "";
  document.getElementById("impostos-partilha-cofins").value = c.partilhaCofins || "";
  document.getElementById("impostos-partilha-pis").value = c.partilhaPis || "";
  document.getElementById("impostos-partilha-cpp").value = c.partilhaCpp || "";
  document.getElementById("impostos-partilha-icmsiss").value = c.partilhaIcmsIss || "";
  // Valores de referência 2026 (INSS 5% do salário mínimo R$1.621 + ICMS/ISS
  // fixos desde 2006) — confirme no Portal do Simples Nacional, pois o INSS
  // muda todo ano junto com o salário mínimo.
  document.getElementById("impostos-mei-inss").value = c.meiInss || "81.05";
  document.getElementById("impostos-mei-icms").value = c.meiIcms || "1.00";
  document.getElementById("impostos-mei-iss").value = c.meiIss || "5.00";
  atualizarCamposImpostos();
}

function lerImpostosConfigDoForm() {
  return {
    regime: document.getElementById("impostos-regime").value,
    atividade: document.getElementById("impostos-atividade").value,
    anexo: document.getElementById("impostos-anexo").value,
    uf: document.getElementById("impostos-uf").value.trim(),
    municipio: document.getElementById("impostos-municipio").value.trim(),
    aliquotaIcms: document.getElementById("impostos-aliquota-icms").value,
    aliquotaIss: document.getElementById("impostos-aliquota-iss").value,
    partilhaIrpj: document.getElementById("impostos-partilha-irpj").value,
    partilhaCsll: document.getElementById("impostos-partilha-csll").value,
    partilhaCofins: document.getElementById("impostos-partilha-cofins").value,
    partilhaPis: document.getElementById("impostos-partilha-pis").value,
    partilhaCpp: document.getElementById("impostos-partilha-cpp").value,
    partilhaIcmsIss: document.getElementById("impostos-partilha-icmsiss").value,
    meiInss: document.getElementById("impostos-mei-inss").value,
    meiIcms: document.getElementById("impostos-mei-icms").value,
    meiIss: document.getElementById("impostos-mei-iss").value,
  };
}

function montarLinhaResultado(nome, valor) {
  const tr = document.createElement("tr");
  const tdNome = document.createElement("td");
  tdNome.textContent = nome;
  const tdValor = document.createElement("td");
  tdValor.textContent = formatBRL(valor);
  tr.appendChild(tdNome);
  tr.appendChild(tdValor);
  return tr;
}

function montarResultadoImpostos(cfg, entradas) {
  const corpo = document.querySelector("#impostos-resultado-tabela tbody");
  corpo.innerHTML = "";
  const kpis = document.getElementById("impostos-resultado-kpis");
  kpis.innerHTML = "";

  let total = 0;
  const linhas = [];

  if (cfg.regime === "Simples Nacional") {
    const r = calcularSimplesNacional(entradas.rbt12, entradas.faturamentoMes, cfg.anexo);
    total = r.dasTotal;
    const partilhas = [
      ["IRPJ", cfg.partilhaIrpj], ["CSLL", cfg.partilhaCsll], ["COFINS", cfg.partilhaCofins],
      ["PIS", cfg.partilhaPis], ["CPP", cfg.partilhaCpp], ["ICMS/ISS", cfg.partilhaIcmsIss],
    ];
    const algumaPartilha = partilhas.some(([, p]) => Number(p) > 0);
    if (algumaPartilha) {
      partilhas.forEach(([nome, p]) => linhas.push([nome, r.dasTotal * ((Number(p) || 0) / 100)]));
    } else {
      linhas.push(["DAS (valor único, sem partilha informada)", r.dasTotal]);
    }
    kpis.appendChild(criarStatSimples("Alíquota efetiva", `${(r.aliquotaEfetiva * 100).toFixed(2)}%`));
    kpis.appendChild(criarStatSimples("DAS estimado do mês", formatBRL(r.dasTotal)));
  } else if (cfg.regime === "Lucro Presumido") {
    const r = calcularLucroPresumido({
      faturamentoMes: entradas.faturamentoMes, atividade: cfg.atividade,
      aliquotaIcms: Number(cfg.aliquotaIcms), aliquotaIss: Number(cfg.aliquotaIss),
    });
    total = r.total;
    linhas.push(["IRPJ", r.irpj], ["CSLL", r.csll], ["PIS", r.pis], ["COFINS", r.cofins]);
    if (r.icms) linhas.push(["ICMS", r.icms]);
    if (r.iss) linhas.push(["ISS", r.iss]);
    kpis.appendChild(criarStatSimples("Total estimado do mês", formatBRL(total)));
  } else if (cfg.regime === "Lucro Real") {
    const r = calcularLucroReal({
      faturamentoMes: entradas.faturamentoMes, lucroApurado: entradas.lucroApurado, atividade: cfg.atividade,
      aliquotaIcms: Number(cfg.aliquotaIcms), aliquotaIss: Number(cfg.aliquotaIss),
    });
    total = r.total;
    linhas.push(["IRPJ", r.irpj], ["CSLL", r.csll], ["PIS", r.pis], ["COFINS", r.cofins]);
    if (r.icms) linhas.push(["ICMS", r.icms]);
    if (r.iss) linhas.push(["ISS", r.iss]);
    kpis.appendChild(criarStatSimples("Total estimado do mês", formatBRL(total)));
  } else {
    const r = calcularMei({
      atividade: cfg.atividade, meiInss: Number(cfg.meiInss), meiIcms: Number(cfg.meiIcms), meiIss: Number(cfg.meiIss),
    });
    total = r.total;
    linhas.push(["INSS", r.inss]);
    if (r.icms) linhas.push(["ICMS", r.icms]);
    if (r.iss) linhas.push(["ISS", r.iss]);
    kpis.appendChild(criarStatSimples("DAS-MEI do mês", formatBRL(total)));
  }

  linhas.forEach(([nome, valor]) => corpo.appendChild(montarLinhaResultado(nome, valor)));
  document.getElementById("impostos-resultado").hidden = false;
}

function criarStatSimples(label, valor) {
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

function setupImpostosConfig() {
  if (impostosConfigReady) return;
  impostosConfigReady = true;

  document.getElementById("impostos-regime").addEventListener("change", atualizarCamposImpostos);
  document.getElementById("impostos-atividade").addEventListener("change", atualizarCamposImpostos);

  document.getElementById("impostos-config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    impostosConfigStatus("Salvando...");
    try {
      await saveImpostosConfig(lerImpostosConfigDoForm(), accessToken);
      impostosConfigStatus("Configuração salva.");
    } catch (err) {
      console.error(err);
      impostosConfigStatus(`Erro ao salvar: ${mensagemDoErro(err)}`);
    }
  });

  document.getElementById("impostos-calc-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const cfg = lerImpostosConfigDoForm();
    const faturamentoMes = Number(document.getElementById("impostos-calc-faturamento").value) || 0;
    const rbt12raw = Number(document.getElementById("impostos-calc-rbt12").value);
    const entradas = {
      faturamentoMes,
      rbt12: rbt12raw > 0 ? rbt12raw : faturamentoMes * 12,
      lucroApurado: Number(document.getElementById("impostos-calc-lucro").value) || 0,
    };
    montarResultadoImpostos(cfg, entradas);
  });
}

async function initImpostos() {
  setupImpostosConfig();
  impostosConfigStatus("");
  document.getElementById("impostos-resultado").hidden = true;
  try {
    await ensureImpostosSheet(accessToken);
    preencherImpostosConfig(await fetchImpostosConfig(accessToken));
  } catch (err) {
    console.error(err);
    if (!isNetworkError(err)) impostosConfigStatus(`Não foi possível carregar a configuração: ${mensagemDoErro(err)}`);
  }
}
