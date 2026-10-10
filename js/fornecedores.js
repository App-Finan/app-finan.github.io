// ERP, Fase 1 — Fornecedores. Deliberately a fixed, positional tab (A:H, see
// FORNECEDORES_HEADERS below), NOT routed through the adaptive esquema.js
// engine Lançamento/Estoque use — a smaller first step; "Conectar planilha"
// does not yet offer Fornecedores a custom tab name. Keep this file's layout
// in sync with FORNECEDORES_TAB/FORNECEDORES_HEADERS in apps-script/Code.gs.
const FORNECEDORES_SHEET_NAME = "Fornecedores";
const FORNECEDORES_HEADERS = ["Nome", "CNPJ/CPF", "Categoria", "Telefone", "E-mail", "Prazo de pagamento", "Observação", "Status"];
const FORNECEDOR_STATUS_ATIVO = "Ativo";
const FORNECEDOR_STATUS_INATIVO = "Inativo";

// Creates the tab the first time it's needed. Tab CREATION is Master-only on
// the gateway (see actionAddTab_ in Code.gs) even though writing rows in it is
// not — same reasoning as ensureUsuariosSheet. A non-Master whose company
// doesn't have the tab yet simply sees an empty list until a Master opens the
// app once; never fatal, same pattern as ensureUsuariosSheet in js/usuarios.js.
async function ensureFornecedoresSheet(token) {
  try {
    const titles = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    if (!titles.includes(FORNECEDORES_SHEET_NAME)) {
      await createSheetTab(CONFIG.SPREADSHEET_ID, FORNECEDORES_SHEET_NAME, token);
      await updateSheetRow(CONFIG.SPREADSHEET_ID, `${FORNECEDORES_SHEET_NAME}!A1:H1`, FORNECEDORES_HEADERS, token);
    }
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    // Not a Master, or some other non-fatal reason (e.g. this company connected
    // its tabs differently): the list just stays empty until it exists.
  }
}

function parseFornecedorRow(row, linha) {
  return {
    linha,
    nome: row[0] ? String(row[0]) : "",
    documento: row[1] ? String(row[1]) : "",
    categoria: row[2] ? String(row[2]) : "",
    telefone: row[3] ? String(row[3]) : "",
    email: row[4] ? String(row[4]) : "",
    prazoPagamento: row[5] ? String(row[5]) : "",
    observacao: row[6] ? String(row[6]) : "",
    status: row[7] ? String(row[7]) : FORNECEDOR_STATUS_ATIVO,
    raw: row,
  };
}

// A blank Nome means an empty or removed row — skipped, same convention as
// loadUsuarios_ on the server. The tab may not exist yet (a fresh company
// whose Master hasn't signed in once): read as an empty list, not an error.
async function fetchFornecedores(token) {
  let rows;
  try {
    rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `${FORNECEDORES_SHEET_NAME}!A2:H`, token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    return [];
  }
  const itens = [];
  rows.forEach((row, index) => {
    if (!row[0]) return;
    itens.push(parseFornecedorRow(row, index + 2));
  });
  return itens;
}

// Same reasoning as findNextLancamentoRow/findNextEstoqueRow: a plain scan for
// the first empty row, written to directly — never values:append (see the note
// in CLAUDE.md on why).
async function findNextFornecedorRow(token) {
  const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `${FORNECEDORES_SHEET_NAME}!A2:A`, token, {
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i][0]) return i + 2;
  }
  return rows.length + 2;
}

async function createFornecedor(values, token) {
  const targetRow = await findNextFornecedorRow(token);
  const row = [
    values.nome,
    values.documento || "",
    values.categoria || "",
    values.telefone || "",
    values.email || "",
    values.prazoPagamento || "",
    values.observacao || "",
    FORNECEDOR_STATUS_ATIVO,
  ];
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `${FORNECEDORES_SHEET_NAME}!A${targetRow}:H${targetRow}`, row, token);
  return targetRow;
}

// Changes only the given fields, starting from a copy of the row's own .raw —
// same "never reconstruct field-by-field" rule as js/estoque.js, so a partial
// update can't blank an unrelated column.
async function updateFornecedor(fornecedor, campos, token) {
  const row = (fornecedor.raw || []).slice();
  while (row.length < 8) row.push("");
  if (campos.nome !== undefined) row[0] = campos.nome;
  if (campos.documento !== undefined) row[1] = campos.documento;
  if (campos.categoria !== undefined) row[2] = campos.categoria;
  if (campos.telefone !== undefined) row[3] = campos.telefone;
  if (campos.email !== undefined) row[4] = campos.email;
  if (campos.prazoPagamento !== undefined) row[5] = campos.prazoPagamento;
  if (campos.observacao !== undefined) row[6] = campos.observacao;
  if (campos.status !== undefined) row[7] = campos.status;
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `${FORNECEDORES_SHEET_NAME}!A${fornecedor.linha}:H${fornecedor.linha}`, row, token);
}

// Deactivating (not deleting the row) because Contas a Pagar, in the next
// phase, will reference a fornecedor by name — losing the row would lose that
// history. Mirrors the "Status" convention Categoria already uses.
async function setFornecedorStatus(fornecedor, status, token) {
  await updateFornecedor(fornecedor, { status }, token);
}
