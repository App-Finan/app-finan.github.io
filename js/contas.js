// ERP, Fase 1 — Contas a Pagar / Contas a Receber. One generic module for both
// (same shape, see CONTAS_HEADERS in apps-script/Code.gs), parametrized by
// "tipo": "pagar" or "receber". Deliberately a fixed, positional tab, same
// reasoning as js/fornecedores.js.
const CONTAS_CONFIG = {
  pagar: {
    tab: "Contas a Pagar",
    statusAberto: "Pendente",
    statusFechado: "Pago",
    contraparteLabel: "Fornecedor",
    tipoLancamento: "Saída",
  },
  receber: {
    tab: "Contas a Receber",
    statusAberto: "Pendente",
    statusFechado: "Recebido",
    contraparteLabel: "Cliente",
    tipoLancamento: "Entrada",
  },
};

function ehContaAtrasada(conta) {
  if (conta.status !== CONTAS_CONFIG[conta.tipo].statusAberto) return false;
  if (!conta.vencimento) return false;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return conta.vencimento.getTime() < hoje.getTime();
}

// Tab CREATION is Master-only on the gateway (actionAddTab_); writing rows in
// an existing one is not. Same non-fatal pattern as ensureFornecedoresSheet —
// a non-Master whose company doesn't have the tab yet just sees an empty list
// until a Master opens the app once.
async function ensureContasSheet(tipo, token) {
  const cfg = CONTAS_CONFIG[tipo];
  try {
    const titles = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    if (!titles.includes(cfg.tab)) {
      await createSheetTab(CONFIG.SPREADSHEET_ID, cfg.tab, token);
      const headers =
        tipo === "pagar"
          ? ["Descrição", "Fornecedor", "Categoria", "Valor", "Vencimento", "Status", "Pago em", "Recorrente", "Observação", "Avisado em"]
          : ["Descrição", "Cliente", "Categoria", "Valor", "Vencimento", "Status", "Recebido em", "Recorrente", "Observação", "Avisado em"];
      await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${cfg.tab}'!A1:J1`, headers, token);
    }
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
  }
}

function parseContaRow(tipo, row, linha) {
  return {
    tipo,
    linha,
    descricao: row[0] ? String(row[0]) : "",
    contraparte: row[1] ? String(row[1]) : "",
    categoria: row[2] ? String(row[2]) : "",
    valor: typeof row[3] === "number" ? row[3] : Number(row[3]) || 0,
    vencimento: sheetSerialToDate(row[4]),
    status: row[5] ? String(row[5]) : CONTAS_CONFIG[tipo].statusAberto,
    dataFechamento: sheetSerialToDate(row[6]),
    recorrente: row[7] === "Sim",
    observacao: row[8] ? String(row[8]) : "",
    avisadoEm: sheetSerialToDate(row[9]),
    raw: row,
  };
}

async function fetchContas(tipo, token) {
  const cfg = CONTAS_CONFIG[tipo];
  let rows;
  try {
    rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${cfg.tab}'!A2:J`, token, { valueRenderOption: "UNFORMATTED_VALUE" });
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    return [];
  }
  const itens = [];
  rows.forEach((row, index) => {
    if (!row[0]) return;
    itens.push(parseContaRow(tipo, row, index + 2));
  });
  return itens;
}

async function findNextContaRow(tipo, token) {
  const cfg = CONTAS_CONFIG[tipo];
  const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${cfg.tab}'!A2:A`, token, { valueRenderOption: "UNFORMATTED_VALUE" });
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i][0]) return i + 2;
  }
  return rows.length + 2;
}

async function createConta(tipo, values, token) {
  const cfg = CONTAS_CONFIG[tipo];
  const targetRow = await findNextContaRow(tipo, token);
  const row = [
    values.descricao,
    values.contraparte || "",
    values.categoria || "",
    Number(values.valor) || 0,
    dateInputToSheetSerial(values.vencimento),
    cfg.statusAberto,
    "",
    values.recorrente ? "Sim" : "Não",
    values.observacao || "",
    "",
  ];
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${cfg.tab}'!A${targetRow}:J${targetRow}`, row, token);
  return targetRow;
}

// Patches only the given fields, starting from .raw — same "never rebuild
// field-by-field" rule as js/estoque.js and js/fornecedores.js.
async function updateConta(tipo, conta, campos, token) {
  const cfg = CONTAS_CONFIG[tipo];
  const row = (conta.raw || []).slice();
  while (row.length < 10) row.push("");
  if (campos.descricao !== undefined) row[0] = campos.descricao;
  if (campos.contraparte !== undefined) row[1] = campos.contraparte;
  if (campos.categoria !== undefined) row[2] = campos.categoria;
  if (campos.valor !== undefined) row[3] = Number(campos.valor) || 0;
  if (campos.vencimentoSerial !== undefined) row[4] = campos.vencimentoSerial;
  if (campos.status !== undefined) row[5] = campos.status;
  if (campos.dataFechamentoSerial !== undefined) row[6] = campos.dataFechamentoSerial;
  if (campos.recorrente !== undefined) row[7] = campos.recorrente ? "Sim" : "Não";
  if (campos.observacao !== undefined) row[8] = campos.observacao;
  if (campos.avisadoEmSerial !== undefined) row[9] = campos.avisadoEmSerial;
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${cfg.tab}'!A${conta.linha}:J${conta.linha}`, row, token);
}

// One month ahead, same day-of-month when possible; a day that doesn't exist
// in the target month (e.g. 31/01 -> fevereiro) falls back to that month's
// last day, rather than silently rolling into março.
function proximoMes(data) {
  const ano = data.getUTCFullYear();
  const mes = data.getUTCMonth();
  const dia = data.getUTCDate();
  const ultimoDiaProximoMes = new Date(Date.UTC(ano, mes + 2, 0)).getUTCDate();
  return new Date(Date.UTC(ano, mes + 1, Math.min(dia, ultimoDiaProximoMes)));
}

function toInputDateValueUTC(date) {
  return date.toISOString().slice(0, 10);
}

// The one settle action: "Pagar" / "Receber". Does three things as one unit —
// (1) writes the matching Lançamento FIRST, through the exact same function
// the "Novo lançamento" form and the offline queue use (submitLancamentoValues,
// js/form.js), so there is exactly one code path for "a lançamento happened";
// (2) only then marks the conta settled, with a note pointing at the row just
// written, so the link is traceable by eye later; (3) if the conta is
// recorrente, rolls the next occurrence forward a month, Pendente, so it is
// there to settle next time — no background job needed. A failure between (1)
// and (2)/(3) leaves a real lançamento with no matching conta update; the
// error is surfaced so the person can fix the conta by hand (see the UI's
// catch block) rather than silently losing the mismatch.
async function settleConta(tipo, conta, { dataFechamento, loja, contaBancaria, empresa, categoria, pessoa }, token) {
  const cfg = CONTAS_CONFIG[tipo];
  const lancamentoRow = await submitLancamentoValues(
    {
      data: dataFechamento,
      tipo: cfg.tipoLancamento,
      valor: conta.valor,
      loja,
      conta: contaBancaria,
      empresa,
      categoria: categoria || conta.categoria,
      pessoa,
      peso: "",
      observacao: `${tipo === "pagar" ? "Pago" : "Recebido"} via ${cfg.tab} — ${conta.descricao}`,
      extras: [],
    },
    token
  );

  await updateConta(
    tipo,
    conta,
    {
      status: cfg.statusFechado,
      dataFechamentoSerial: dateInputToSheetSerial(dataFechamento),
      observacao: appendObservacao(conta.observacao, `Lançamento criado na linha ${lancamentoRow}`),
    },
    token
  );

  if (conta.recorrente) {
    await createConta(
      tipo,
      {
        descricao: conta.descricao,
        contraparte: conta.contraparte,
        categoria: conta.categoria,
        valor: conta.valor,
        vencimento: toInputDateValueUTC(proximoMes(conta.vencimento)),
        recorrente: true,
        observacao: conta.observacao,
      },
      token
    );
  }

  return lancamentoRow;
}
