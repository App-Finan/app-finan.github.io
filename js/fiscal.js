// Ajustes → "Configuração Fiscal" (2026-10-16). Scaffolding for the future
// automated NF-e emission: a place for the company's Master to save the
// chosen provider's name, environment (Homologação/Produção), CNPJ emissor
// and API token/chave — NOTHING here actually calls any NF-e provider yet.
// This exists so the credentials have somewhere real (the company's own
// spreadsheet, not localStorage) to live once a provider and a digital
// certificate are in place; wiring an actual "Emitir NF" action is separate,
// later work. Fixed, positional, single-row tab (like Usuários/Configuração),
// NOT routed through the adaptive esquema.js engine. Master-only on the
// gateway for BOTH reads and writes (see FISCAL_TAB in apps-script/Code.gs) —
// stricter than every other ERP tab, since this one holds a credential.
const FISCAL_SHEET_NAME = "Configuração Fiscal";
const FISCAL_HEADERS = ["Provedor", "Ambiente", "CNPJ Emissor", "Token/Chave de API", "Atualizado em"];
let fiscalConfigReady = false;

// Creates the tab the first time a Master opens this card. Non-fatal on
// failure (not a Master, or some other reason) — same pattern as
// ensureFornecedoresSheet: the form just starts empty until it exists.
async function ensureFiscalSheet(token) {
  try {
    const titles = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    if (!titles.includes(FISCAL_SHEET_NAME)) {
      await createSheetTab(CONFIG.SPREADSHEET_ID, FISCAL_SHEET_NAME, token);
      await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${FISCAL_SHEET_NAME}'!A1:E1`, FISCAL_HEADERS, token);
    }
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
  }
}

function parseFiscalRow(row) {
  return {
    provedor: row[0] ? String(row[0]) : "",
    ambiente: row[1] ? String(row[1]) : "Homologação",
    cnpjEmissor: row[2] ? String(row[2]) : "",
    token: row[3] ? String(row[3]) : "",
    atualizadoEm: row[4] ? String(row[4]) : "",
  };
}

// Returns null when nothing has been saved yet (no row, or the tab doesn't
// exist/this account isn't Master — the gateway denies the read, same as any
// other network-shaped failure here, so the form just starts empty).
async function fetchFiscalConfig(token) {
  try {
    const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${FISCAL_SHEET_NAME}'!A2:E2`, token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    if (!rows.length || !rows[0].some(Boolean)) return null;
    return parseFiscalRow(rows[0]);
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    return null;
  }
}

// Always overwrites the single row — there is never a "next empty row" scan
// for this tab, unlike every other ERP module here.
async function saveFiscalConfig(values, token) {
  const row = [
    values.provedor || "",
    values.ambiente || "Homologação",
    values.cnpjEmissor || "",
    values.token || "",
    new Date().toLocaleString("pt-BR"),
  ];
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${FISCAL_SHEET_NAME}'!A2:E2`, row, token);
  return row;
}

function fiscalConfigStatus(message) {
  const el = document.getElementById("fiscal-config-status");
  if (el) {
    el.textContent = message || "";
    el.classList.toggle("status-erro", /^Erro/.test(message || ""));
  }
}

function preencherFiscalConfig(cfg) {
  document.getElementById("fiscal-provedor").value = cfg ? cfg.provedor : "";
  document.getElementById("fiscal-ambiente").value = cfg && cfg.ambiente ? cfg.ambiente : "Homologação";
  document.getElementById("fiscal-cnpj").value = cfg ? cfg.cnpjEmissor : "";
  document.getElementById("fiscal-token").value = cfg ? cfg.token : "";
  const nota = document.getElementById("fiscal-status-nota");
  if (!nota) return;
  nota.textContent =
    cfg && cfg.token
      ? `Configuração salva${cfg.atualizadoEm ? " em " + cfg.atualizadoEm : ""}. A emissão automática de NF ainda não está ativa.`
      : "Nenhuma configuração salva ainda. A emissão automática de NF só fica disponível depois que o certificado digital e o provedor estiverem prontos.";
}

function setupFiscalConfig() {
  if (fiscalConfigReady) return;
  fiscalConfigReady = true;
  document.getElementById("fiscal-config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {
      provedor: document.getElementById("fiscal-provedor").value,
      ambiente: document.getElementById("fiscal-ambiente").value,
      cnpjEmissor: document.getElementById("fiscal-cnpj").value.trim(),
      token: document.getElementById("fiscal-token").value.trim(),
    };
    fiscalConfigStatus("Salvando...");
    try {
      await saveFiscalConfig(values, accessToken);
      fiscalConfigStatus("Configuração salva.");
      preencherFiscalConfig(await fetchFiscalConfig(accessToken));
    } catch (err) {
      console.error(err);
      fiscalConfigStatus(`Erro ao salvar: ${mensagemDoErro(err)}`);
    }
  });
}

// Called on every sign-in / company switch, same as initListasAdmin: the
// wiring above happens once, but the configuration shown must always belong
// to whichever company is currently open.
async function initFiscalConfig() {
  setupFiscalConfig();
  fiscalConfigStatus("");
  try {
    await ensureFiscalSheet(accessToken);
    preencherFiscalConfig(await fetchFiscalConfig(accessToken));
  } catch (err) {
    console.error(err);
    if (!isNetworkError(err)) fiscalConfigStatus(`Não foi possível carregar a configuração: ${mensagemDoErro(err)}`);
  }
}
