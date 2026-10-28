/**
 * Finan. gateway — a Google Apps Script web app that sits between the app
 * (browser) and the spreadsheets.
 *
 * Why it exists: without it, every person using the app needs the company's
 * spreadsheet shared with their own Google account in Drive. With it, the
 * script runs as the spreadsheet OWNER; people only prove who they are (Google
 * sign-in, email scope only) and the script decides — from the "Usuários" tab
 * of each spreadsheet — what they may read or write. The spreadsheets no
 * longer need to be shared with anyone but the owner.
 *
 * SECURITY: this file IS the access-control boundary now. Anything the browser
 * sends is untrusted. Every request: (1) verifies the Google access token and
 * that it was issued to THIS app's client id, (2) looks the email up in the
 * target spreadsheet's Usuários tab, (3) checks the role against the action.
 * Roles are enforced here, not just in the UI.
 *
 * Setup steps are in apps-script/LEIA-ME.md.
 */

const GATEWAY_CONFIG = {
  // Must match CONFIG.CLIENT_ID in js/config.js. Tokens issued to any other
  // OAuth client are refused (prevents another app replaying a user's token).
  CLIENT_ID: "421144448289-jfiiagc3pij4qoaoq0m2dhnjuda4ua8t.apps.googleusercontent.com",

  // The ONLY spreadsheets this gateway will ever touch.
  SPREADSHEETS: {
    "1nZsFn7K2PpMq36jmBr6hjqHZU8gqHzjPUEzG0rFmmUQ": { empresa: "Ipanema Joias", sheetName: "Lançamento", segmento: "joalheria" },
    "1DdJs0mLYiJuMctNVc-xN1rZgs3OEXOgZI5JJjfeU2AA": { empresa: "Carolina Joias", sheetName: "Lançamento", segmento: "joalheria" },
  },

  // May set up a company whose Usuários tab is missing or empty (becoming its
  // first Master). Everyone else must be added by an existing Master.
  // The developer / system account comes first. The personal account stays here
  // only until the new one is confirmed working; then remove it (it would keep
  // seeing the Painel do sistema).
  ADMIN_EMAILS: ["finanponto@gmail.com"],

  // Where people are sent in the e-mails about access requests.
  APP_URL: "https://app-finan.github.io/",
};

// Shown by the public banner (a GET on the /exec URL) so it is easy to confirm
// which version of this file is really deployed.
const GATEWAY_VERSION = "2026-10-28-cadastro-self-service";

const USUARIOS_TAB = "Usuários";
// ERP, Fase 1 — Fornecedores (see CLAUDE.md "ERP: Fornecedores"). Deliberately
// a fixed, positional tab (like Usuários), NOT routed through the adaptive
// esquema.js engine Lançamento/Estoque use — a smaller first step; "Conectar
// planilha" does not yet offer it a custom tab name.
const FORNECEDORES_TAB = "Fornecedores";
const FORNECEDORES_HEADERS = ["Nome", "CNPJ/CPF", "Categoria", "Telefone", "E-mail", "Prazo de pagamento", "Observação", "Status"];
// ERP, Fase 1 — Contas a Pagar / Contas a Receber. Same fixed-tab reasoning as
// Fornecedores above. Columns: Descrição, Fornecedor/Cliente (free text —
// separate from the Pessoa lookup; the "Pagar"/"Receber" action asks which
// Pessoa it really was, since that write goes through Lançamento, which
// requires one), Categoria, Valor, Vencimento (date serial), Status
// ("Pendente" | "Pago"/"Recebido" — "Atrasado" is never stored, only computed
// from Vencimento < hoje), Pago em / Recebido em (date serial, blank until
// settled), Recorrente ("Sim"/"Não"), Observação, Avisado em (date serial of
// the last reminder e-mail that covered this row, blank if never — dedupe key
// for lembretesVencimento_, see below).
const CONTAS_PAGAR_TAB = "Contas a Pagar";
const CONTAS_RECEBER_TAB = "Contas a Receber";
const CONTAS_HEADERS = {
  [CONTAS_PAGAR_TAB]: ["Descrição", "Fornecedor", "Categoria", "Valor", "Vencimento", "Status", "Pago em", "Recorrente", "Observação", "Avisado em"],
  [CONTAS_RECEBER_TAB]: ["Descrição", "Cliente", "Categoria", "Valor", "Vencimento", "Status", "Recebido em", "Recorrente", "Observação", "Avisado em"],
};
// Conciliação bancária (2026-10-18) — importação de extrato OFX/CSV, ver
// js/extrato.js. Cada linha é uma transação real do banco (não um lançamento
// do app): Valor já vem com o sinal do próprio extrato, Tipo é só uma
// conveniência de leitura (igual Status em Contas a Pagar), Conciliado/
// "Lançamento vinculado" marcam se essa linha já foi pareada com um
// Lançamento real, e "Origem ID" (o FITID do OFX, ou um hash para CSV) evita
// duplicar uma transação ao reimportar um período que já foi importado antes.
// Mesmo split de acesso que Fornecedores/Contas (não FISCAL_TAB):
// leitura geral, escrita Editor+Master via READ_TABS/WRITE_TABS — não guarda
// nenhum segredo, é só mais um dado financeiro da empresa.
const EXTRATO_TAB = "Extrato Bancário";
const EXTRATO_HEADERS = ["Data", "Conta", "Descrição", "Valor", "Tipo", "Conciliado", "Lançamento vinculado", "Origem ID", "Importado em"];
// "Configuração Fiscal" tab (2026-10-16): where a company's Master stores the
// NF-e provider credentials (provedor, ambiente, CNPJ emissor, token/chave de
// API) for when real automated NF emission is built — this ONLY stores the
// configuration today, nothing here actually calls a provider yet. Deliberately
// NOT pre-seeded in companyTemplate_ (lazy-created on first use, like
// Configuração) and NOT in READ_TABS/WRITE_TABS: it holds a secret, so both
// reads and writes are Master-only, stricter than Configuração (readable by
// everyone) and closer to Usuários. Always exactly one data row (A2:E2) —
// there is only ever one fiscal configuration per company.
const FISCAL_TAB = "Configuração Fiscal";
const FISCAL_HEADERS = ["Provedor", "Ambiente", "CNPJ Emissor", "Token/Chave de API", "Atualizado em"];
// Tab CREATION is Master-only (actionAddTab_); writing ROWS in an existing one
// is Editor+Master (WRITE_TABS) — same split as Fornecedores, same reasoning
// as Configuração: creating a tab is a structural change to the spreadsheet.
// FISCAL_TAB is the one exception: it is listed here too (so actionAddTab_
// lets a Master create it) but deliberately left OUT of WRITE_TABS below —
// its row writes are special-cased Master-only in actionUpdateValues_, the
// same way Configuração's are, because this tab holds an API credential, not
// ordinary business data an Editor should see or touch.
const ERP_MASTER_ONLY_TABS = [FORNECEDORES_TAB, CONTAS_PAGAR_TAB, CONTAS_RECEBER_TAB, EXTRATO_TAB, FISCAL_TAB];
const LOOKUP_TABS = ["Lojas", "Contas", "Empresas", "Categoria", "Pessoa", "Produto", "Tipo de Produto", "Marcas"];
const MAX_COMPANIES = 200;
const REQUESTS_TAB = "Solicitações";
const REQUEST_HEADERS = ["Data", "E-mail", "Nome", "Empresa", "Tipo", "Mensagem", "Status", "Nota"];
const MAX_PENDING_REQUESTS = 300;
const REQUEST_TYPES = ["nova", "existente"];
const REGISTRY_PROP = "REGISTRY_SPREADSHEET_ID";
const REGISTRY_TITLE = "Finan. — Registro de empresas";

// Structure of every company created from inside the app. A new company starts
// with just enough seed rows in the lists for the forms to be usable; its Master
// edits the lists later (Ajustes → Listas de apoio).
const LOOKUP_HEADERS = ["Código", "Nome", "Complemento"];
function seedRow_(n, nome, extra) {
  const row = [n, nome, n + " - " + nome];
  if (extra) row.push(extra);
  return row;
}
// Business segments. "id" is what travels between the app and this script,
// and only picks the WORDS on the company's new spreadsheet template (qtd/
// qtdEstoque/esp below) — per-segment brand names (FinanGold, FinanPet...)
// were removed 2026-10-12; every company's spreadsheet title now just says
// "Finan." (see actionCreateCompany_ below). Keep the ids in sync with
// SEGMENTOS in js/segmentos.js.
const SEGMENTO_PADRAO = "joalheria";
const SEGMENTOS = {
  joalheria: { qtd: "Peso (g)", qtdEstoque: "Peso em grama", esp: "Pureza (k)" },
  petshop: {},
  comercio: {},
  servicos: {},
  alimentacao: {},
  saude: {},
  outro: {},
};
function segmentoValido_(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(SEGMENTOS, id) ? id : SEGMENTO_PADRAO;
}

// The columns stay the same for every segment (so the app reads them the same
// way); only the header WORDS that name gold-specific things change.
function companyTemplate_(segmento) {
  const seg = SEGMENTOS[segmentoValido_(segmento)];
  const qtd = seg.qtd || "Quantidade";
  const qtdEstoque = seg.qtdEstoque || "Quantidade";
  const esp = seg.esp || "Especificação";
  return [
    { name: "Lançamento", dateCols: [0], headers: ["Data", "Loja", "Conta", "Empresa", "Categoria", "Valor", "Tipo", qtd, "Pessoa", "Observação"], seeds: () => [] },
    { name: "Estoque", dateCols: [9, 10], headers: ["Produto", "Tipo", "Marca", "Condição", "Estado", qtdEstoque, esp, "Valor de Custo", "Valor de venda", "Data de Compra", "Data de Venda", "Comprador", "Vendedor", "Loja", "Vendido?", "Observação"], seeds: () => [] },
    { name: FORNECEDORES_TAB, headers: FORNECEDORES_HEADERS, seeds: () => [] },
    { name: CONTAS_PAGAR_TAB, headers: CONTAS_HEADERS[CONTAS_PAGAR_TAB], seeds: () => [] },
    { name: CONTAS_RECEBER_TAB, headers: CONTAS_HEADERS[CONTAS_RECEBER_TAB], seeds: () => [] },
    { name: EXTRATO_TAB, headers: EXTRATO_HEADERS, seeds: () => [] },
    { name: "Lojas", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Loja principal")] },
    { name: "Contas", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Caixa"), seedRow_(2, "Banco")] },
    { name: "Empresas", headers: LOOKUP_HEADERS, seeds: (empresa) => [seedRow_(1, empresa)] },
    { name: "Categoria", headers: LOOKUP_HEADERS.concat(["Status"]), seeds: () => ["Vendas", "Compras", "Despesas fixas", "Salários", "Impostos", "Outros"].map((n, i) => seedRow_(i + 1, n, "Ativo")) },
    { name: "Pessoa", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Geral")] },
    { name: "Produto", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Produto geral")] },
    { name: "Tipo de Produto", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Geral")] },
    { name: "Marcas", headers: LOOKUP_HEADERS, seeds: () => [seedRow_(1, "Sem marca")] },
    { name: "Usuários", headers: ["Email", "Nome", "Perfil"], seeds: () => [] },
  ];
}
const READ_TABS = ["Estoque", FORNECEDORES_TAB, CONTAS_PAGAR_TAB, CONTAS_RECEBER_TAB, EXTRATO_TAB, "Lojas", "Contas", "Empresas", "Categoria", "Pessoa", "Produto", "Tipo de Produto", "Marcas"];
const WRITE_TABS = ["Estoque", FORNECEDORES_TAB, CONTAS_PAGAR_TAB, CONTAS_RECEBER_TAB, EXTRATO_TAB]; // plus the company's own ledger tab (sheetName)
const ROLE_VISUALIZADOR = "Visualizador";
const ROLE_EDITOR = "Editor";
const ROLE_MASTER = "Master";
const VALID_ROLES = [ROLE_VISUALIZADOR, ROLE_EDITOR, ROLE_MASTER];
const MAX_BODY_CHARS = 200000;
const MAX_CELL_CHARS = 2000;
const MAX_ROW_CELLS = 60;
const USUARIOS_CACHE_SECONDS = 20;

// "Configuração" tab: which tabs of the company's spreadsheet play which role,
// for companies whose tabs are not named like the defaults. Rows: Papel, Aba,
// where Papel is "lancamentos", "estoque" or "lista:<chave>". Everyone in the
// company may read it; only the Master writes it. It only ever ADDS tabs the
// app may use — Usuários and Configuração themselves can never be named in it.
const CONFIG_TAB = "Configuração";
const CONFIG_ROLES = ["lancamentos", "estoque"];
const CONFIG_LIST_KEYS = ["lojas", "contas", "empresas", "categorias", "pessoas", "produtos", "tiposProduto", "marcas"];
const MAX_CONFIG_ROWS = 30;

function GatewayError_(status, message) {
  this.status = status;
  this.message = message;
}

// ---------------------------------------------------------------------------
// Web app entry point (the only code that touches Apps Script services)
// ---------------------------------------------------------------------------

function doPost(e) {
  let result;
  try {
    const raw = e && e.postData ? e.postData.contents : "";
    if (!raw || raw.length > MAX_BODY_CHARS) throw new GatewayError_(400, "Requisição inválida.");
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      throw new GatewayError_(400, "Requisição inválida.");
    }
    result = { ok: true, data: handleRequest(body, realDeps_()) };
  } catch (err) {
    if (err instanceof GatewayError_) {
      result = { ok: false, status: err.status, error: err.message };
    } else {
      console.error(err);
      result = { ok: false, status: 500, error: "Erro interno no servidor do app." };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput("Finan. gateway ativo. Versão " + GATEWAY_VERSION);
}

// Run this from the Apps Script editor (it is NOT reachable through the web
// app): prints what has to be moved when the system changes accounts — the
// registry spreadsheet id and every company spreadsheet — with direct links.
function diagnostico_migracao() {
  const cache = CacheService.getScriptCache();
  const link = (id) => "https://docs.google.com/spreadsheets/d/" + id;
  console.log("Versão do servidor: " + GATEWAY_VERSION);
  console.log("Registro de empresas (propriedade " + REGISTRY_PROP + "): " + (PropertiesService.getScriptProperties().getProperty(REGISTRY_PROP) || "(ainda não criado)"));
  Object.keys(GATEWAY_CONFIG.SPREADSHEETS).forEach((id) => {
    console.log("Empresa fixa no servidor: " + GATEWAY_CONFIG.SPREADSHEETS[id].empresa + " -> " + link(id));
  });
  registryDeps_(cache).list().forEach((c) => {
    console.log("Empresa criada pelo app: " + c.empresa + " -> " + link(c.spreadsheetId));
  });
  const registryId = PropertiesService.getScriptProperties().getProperty(REGISTRY_PROP);
  if (registryId) console.log("Planilha do registro (transferir também): " + link(registryId));
}

// Run this from the Apps Script editor (it is NOT reachable through the web app)
// when someone says "my e-mail is authorised but I cannot get in". Put their
// address below, choose this function and press Run: the log shows, for each
// company, every row of the Usuários tab, how each e-mail was understood, whether
// it matches, near-misses (typos) and invisible characters.
const EMAIL_PARA_TESTAR = "mariateste@gmail.com";

function distanciaEdicao_(a, b) {
  if (a === b) return 0;
  let anterior = [];
  for (let j = 0; j <= b.length; j += 1) anterior.push(j);
  for (let i = 1; i <= a.length; i += 1) {
    const atual = [i];
    for (let j = 1; j <= b.length; j += 1) atual.push(Math.min(atual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    anterior = atual;
  }
  return anterior[b.length];
}

function diagnostico_acesso() {
  const deps = realDeps_();
  const alvo = canonEmail_(EMAIL_PARA_TESTAR);
  console.log("E-mail testado: " + EMAIL_PARA_TESTAR + "  (comparado como: " + alvo + ")");
  console.log("Versão do servidor: " + GATEWAY_VERSION);
  const empresas = companyMap_(deps);
  Object.keys(empresas).forEach((id) => {
    console.log("== " + empresas[id].empresa + " (" + id + ")");
    let rows;
    try {
      rows = Sheets.Spreadsheets.Values.get(id, USUARIOS_TAB + "!A2:C", { valueRenderOption: "UNFORMATTED_VALUE" }).values || [];
    } catch (err) {
      console.log("   Não consegui ler a aba Usuários desta planilha: " + err.message);
      return;
    }
    console.log("   " + rows.length + " linha(s) na aba Usuários.");
    let achou = false;
    rows.forEach((row, i) => {
      const cru = row[0];
      const n = i + 2;
      if (typeof cru !== "string" || !cru.trim()) {
        if (cru !== undefined && cru !== "") console.log("   linha " + n + ": a coluna A não é texto: " + JSON.stringify(cru));
        return;
      }
      const chave = canonEmail_(cru);
      const igual = chave === alvo;
      if (igual) achou = true;
      const estranhos = cru.split("").filter((c) => !/[\x21-\x7e]/.test(c)).map((c) => "U+" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
      let nota = "";
      if (igual) nota += "   <-- É ESTE (libera o acesso)";
      else if (distanciaEdicao_(chave, alvo) <= 2) nota += "   <-- MUITO PARECIDO: confira se há erro de digitação";
      if (estranhos.length) nota += "   [caracteres invisíveis ou fora do comum: " + estranhos.join(" ") + "]";
      console.log("   linha " + n + ": \"" + cru + "\"  perfil=" + (row[2] ? row[2] : "(vazio: vale Visualizador)") + nota);
    });
    console.log("   RESULTADO: " + (achou ? "o e-mail ESTÁ liberado nesta empresa." : "o e-mail NÃO está nesta empresa."));
  });
}

function realDeps_() {
  const cache = CacheService.getScriptCache();
  return {
    config: GATEWAY_CONFIG,
    verifyToken: verifyGoogleToken_,
    cache: {
      get: (k) => cache.get(k),
      put: (k, v, s) => cache.put(k, v, s),
      remove: (k) => cache.remove(k),
    },
    lock: (fn) => {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(15000)) throw new GatewayError_(503, "Servidor ocupado. Tente novamente.");
      try {
        return fn();
      } finally {
        lock.releaseLock();
      }
    },
    registry: registryDeps_(cache),
    requests: requestsDeps_(),
    logins: loginsDeps_(cache),
    secrets: secretsDeps_(),
    quotaEmail: quotaEmailDeps_(),
    pushTokens: pushTokensDeps_(cache),
    indiceEmails: indiceEmailsDeps_(cache),
    // Config-gated, same no-op-until-configured pattern as push/whatsapp:
    // null when RECAPTCHA_SECRET_KEY isn't set, so verificarCaptcha_ passes
    // every signup through unchecked until it is (see that function's own
    // comment for why this is safe to ship but not safe to publicize yet).
    recaptcha: recaptchaSecreta_() ? { verificar: (token) => verificarCaptchaReal_(token, recaptchaSecreta_()) } : null,
    push: {
      enviar: (token, titulo, corpo) =>
        enviarPushFCM_({ cache: { get: (k) => cache.get(k), put: (k, v, s) => cache.put(k, v, s) }, now: () => Date.now() }, token, titulo, corpo, GATEWAY_CONFIG.APP_URL),
    },
    whatsapp: {
      enviar: (totalContas, empresaNome) => enviarWhatsAppTeste_(totalContas, empresaNome),
    },
    now: () => Date.now(),
    randomHex: randomHex_,
    mail: {
      // Plain text only, addressed to fixed recipients or to the requester.
      send: (msg) => MailApp.sendEmail({ to: msg.to, subject: msg.subject, body: msg.body, name: "Finan." }),
    },
    sheets: {
      // Creates the spreadsheet (owned by whoever deployed this script) with
      // every tab, header and seed row of companyTemplate_(segmento). Returns its id.
      createCompanySpreadsheet: (title, empresaNome, segmento) => {
        const template = companyTemplate_(segmento);
        const created = Sheets.Spreadsheets.create({
          properties: { title: title },
          sheets: template.map((t) => ({ properties: { title: t.name } })),
        });
        const id = created.spreadsheetId;
        Sheets.Spreadsheets.Values.batchUpdate(
          {
            valueInputOption: "RAW",
            data: template.map((t) => ({ range: t.name + "!A1", values: [t.headers].concat(t.seeds(empresaNome)) })),
          },
          id
        );
        const requests = [];
        created.sheets.forEach((sheet, i) => {
          (template[i].dateCols || []).forEach((col) => {
            requests.push({
              repeatCell: {
                range: { sheetId: sheet.properties.sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
                cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/MM/yyyy" } } },
                fields: "userEnteredFormat.numberFormat",
              },
            });
          });
        });
        if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, id);
        return id;
      },
      getTitles: (id) => {
        const data = Sheets.Spreadsheets.get(id, { fields: "sheets.properties.title" });
        return (data.sheets || []).map((s) => s.properties.title);
      },
      getValues: (id, range, valueRenderOption) => {
        const opts = valueRenderOption ? { valueRenderOption: valueRenderOption } : {};
        const data = Sheets.Spreadsheets.Values.get(id, range, opts);
        return data.values || [];
      },
      // RAW on purpose: a value starting with "=" must stay literal text
      // (formula injection), and dates are written as serial numbers.
      updateValues: (id, range, values) => {
        Sheets.Spreadsheets.Values.update({ values: values }, id, range, { valueInputOption: "RAW" });
      },
      addTab: (id, title) => {
        Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: title } } }] }, id);
      },
    },
  };
}

// Companies created from inside the app live in a small registry spreadsheet
// (its id is kept in the script's properties, created on first use).
function registryDeps_(cache) {
  const props = PropertiesService.getScriptProperties();
  return {
    list: () => {
      const cached = cache.get("reg_list");
      if (cached) return JSON.parse(cached);
      const id = props.getProperty(REGISTRY_PROP);
      const out = [];
      if (id) {
        const data = Sheets.Spreadsheets.Values.get(id, "Empresas!A2:F", { valueRenderOption: "UNFORMATTED_VALUE" });
        (data.values || []).forEach((row) => {
          if (row[0] && String(row[4] || "Sim") !== "Não") {
            out.push({ spreadsheetId: String(row[0]), empresa: String(row[1] || ""), sheetName: "Lançamento", segmento: segmentoValido_(String(row[5] || "")) });
          }
        });
      }
      cache.put("reg_list", JSON.stringify(out), 60);
      return out;
    },
    // Unlike list() above, this ALSO returns inactive companies (with their
    // real "Ativa" state) — used only by the system admin's company
    // management screen, never by companyMap_/routing, so a deactivated
    // company still shows up there (to be reactivated) but never becomes
    // reachable again through the normal login/access path. Also carries
    // testeExpiraEm/avisoTesteEm (columns G/H, 2026-10-28 — see "Cadastro
    // self-service" in CLAUDE.md): blank/undefined for a company created
    // through the admin-only Painel do sistema path (no trial clock at all),
    // a date serial for one created through self-service signup.
    listAll: () => {
      const id = props.getProperty(REGISTRY_PROP);
      const out = [];
      if (id) {
        const data = Sheets.Spreadsheets.Values.get(id, "Empresas!A2:H", { valueRenderOption: "UNFORMATTED_VALUE" });
        (data.values || []).forEach((row) => {
          if (!row[0]) return;
          out.push({
            spreadsheetId: String(row[0]),
            empresa: String(row[1] || ""),
            segmento: segmentoValido_(String(row[5] || "")),
            ativa: String(row[4] || "Sim") !== "Não",
            testeExpiraEm: typeof row[6] === "number" ? row[6] : null,
            avisoTesteEm: typeof row[7] === "number" ? row[7] : null,
          });
        });
      }
      return out;
    },
    // Soft "exclusão": flips the Empresas tab's own "Ativa" column, never
    // deletes the row or the company's spreadsheet. Once Ativa is "Não",
    // companyMap_ (built from list() above) simply stops including this
    // company — every gateway action on it then hits the ordinary "Empresa
    // não permitida" refusal, for every user, immediately (no separate
    // enforcement needed). Reversible: the same call with ativa=true
    // reactivates it, same as Fornecedores' Ativo/Inativo or Contas'
    // Cancelada/Reabrir elsewhere in this file — never a real delete, same
    // convention as the rest of this app.
    setActive: (spreadsheetId, ativa) => {
      const id = props.getProperty(REGISTRY_PROP);
      if (!id) return false;
      const data = Sheets.Spreadsheets.Values.get(id, "Empresas!A2:A", { valueRenderOption: "UNFORMATTED_VALUE" });
      const rows = data.values || [];
      for (let i = 0; i < rows.length; i += 1) {
        if (String(rows[i][0]) === spreadsheetId) {
          const linha = i + 2;
          Sheets.Spreadsheets.Values.update({ values: [[ativa ? "Sim" : "Não"]] }, id, "Empresas!E" + linha + ":E" + linha, { valueInputOption: "RAW" });
          cache.remove("reg_list");
          return true;
        }
      }
      return false;
    },
    // Dedupe stamp for the trial-ending reminder e-mails (2026-10-28) — same
    // reasoning as Contas a Pagar/Receber's own "Avisado em" column: a sheet
    // cell survives across logins/trigger runs, a cache key would not (and
    // CacheService's own max TTL, 6h, is too short to mean "today" anyway).
    marcarAvisoTeste: (spreadsheetId, serial) => {
      const id = props.getProperty(REGISTRY_PROP);
      if (!id) return false;
      const data = Sheets.Spreadsheets.Values.get(id, "Empresas!A2:A", { valueRenderOption: "UNFORMATTED_VALUE" });
      const rows = data.values || [];
      for (let i = 0; i < rows.length; i += 1) {
        if (String(rows[i][0]) === spreadsheetId) {
          const linha = i + 2;
          Sheets.Spreadsheets.Values.update({ values: [[serial]] }, id, "Empresas!H" + linha + ":H" + linha, { valueInputOption: "RAW" });
          cache.remove("reg_list");
          return true;
        }
      }
      return false;
    },
    // entry.testeExpiraEm is optional: omitted (or null/undefined) for a
    // company created through the admin-only Painel do sistema path — no
    // trial clock, matches today's behavior exactly; a date serial for one
    // created through self-service signup (acaoSignupConfirmar_ below).
    add: (entry) => {
      let id = props.getProperty(REGISTRY_PROP);
      if (!id) {
        const created = Sheets.Spreadsheets.create({ properties: { title: REGISTRY_TITLE }, sheets: [{ properties: { title: "Empresas" } }] });
        id = created.spreadsheetId;
        Sheets.Spreadsheets.Values.update({ values: [["ID da planilha", "Empresa", "Criada em", "Criada por", "Ativa", "Segmento", "Teste expira em", "Aviso de teste enviado em"]] }, id, "Empresas!A1:H1", { valueInputOption: "RAW" });
        props.setProperty(REGISTRY_PROP, id);
      }
      const existing = Sheets.Spreadsheets.Values.get(id, "Empresas!A2:A");
      const next = (existing.values || []).length + 2;
      Sheets.Spreadsheets.Values.update(
        { values: [[entry.spreadsheetId, entry.empresa, new Date().toISOString(), entry.criadaPor, "Sim", segmentoValido_(entry.segmento), entry.testeExpiraEm || "", ""]] },
        id,
        "Empresas!A" + next + ":H" + next,
        { valueInputOption: "RAW" }
      );
      cache.remove("reg_list");
    },
  };
}

// Access requests live in the registry spreadsheet, tab "Solicitações"
// (created on first use). Columns: Data, E-mail, Nome, Empresa, Tipo,
// Mensagem, Status (Pendente/Atendida/Recusada), Nota.
function requestsDeps_() {
  const props = PropertiesService.getScriptProperties();

  function registryId_() {
    let id = props.getProperty(REGISTRY_PROP);
    if (!id) {
      const created = Sheets.Spreadsheets.create({ properties: { title: REGISTRY_TITLE }, sheets: [{ properties: { title: "Empresas" } }] });
      id = created.spreadsheetId;
      Sheets.Spreadsheets.Values.update({ values: [["ID da planilha", "Empresa", "Criada em", "Criada por", "Ativa", "Segmento", "Teste expira em", "Aviso de teste enviado em"]] }, id, "Empresas!A1:H1", { valueInputOption: "RAW" });
      props.setProperty(REGISTRY_PROP, id);
    }
    const titles = (Sheets.Spreadsheets.get(id, { fields: "sheets.properties.title" }).sheets || []).map((x) => x.properties.title);
    if (titles.indexOf(REQUESTS_TAB) === -1) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: REQUESTS_TAB } } }] }, id);
      Sheets.Spreadsheets.Values.update({ values: [REQUEST_HEADERS] }, id, REQUESTS_TAB + "!A1:H1", { valueInputOption: "RAW" });
    }
    return id;
  }

  return {
    list: () => {
      if (!props.getProperty(REGISTRY_PROP)) return [];
      const id = registryId_();
      const data = Sheets.Spreadsheets.Values.get(id, REQUESTS_TAB + "!A2:H", { valueRenderOption: "UNFORMATTED_VALUE" });
      const out = [];
      (data.values || []).forEach((row, index) => {
        if (!row[1]) return;
        out.push({
          linha: index + 2,
          data: String(row[0] || ""),
          email: String(row[1]).trim().toLowerCase(),
          nome: String(row[2] || ""),
          empresa: String(row[3] || ""),
          tipo: String(row[4] || ""),
          mensagem: String(row[5] || ""),
          status: String(row[6] || "Pendente"),
          nota: String(row[7] || ""),
        });
      });
      return out;
    },
    add: (r) => {
      const id = registryId_();
      const existing = Sheets.Spreadsheets.Values.get(id, REQUESTS_TAB + "!A2:A");
      const next = (existing.values || []).length + 2;
      Sheets.Spreadsheets.Values.update(
        { values: [[new Date().toISOString(), r.email, r.nome, r.empresa, r.tipo, r.mensagem, "Pendente", ""]] },
        id,
        REQUESTS_TAB + "!A" + next + ":H" + next,
        { valueInputOption: "RAW" }
      );
    },
    setStatus: (linha, status, nota) => {
      const id = registryId_();
      Sheets.Spreadsheets.Values.update({ values: [[status, nota]] }, id, REQUESTS_TAB + "!G" + linha + ":H" + linha, { valueInputOption: "RAW" });
    },
  };
}

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes
    .map((b) => ("0" + (b & 0xff).toString(16)).slice(-2))
    .join("");
}

// Returns the verified, lower-cased email for a Google access token, or throws
// 401. Uses Google's tokeninfo endpoint, and checks the token was issued to
// this app's OAuth client.
function verifyGoogleToken_(token) {
  if (!token || typeof token !== "string" || token.length > 4096) {
    throw new GatewayError_(401, "Sessão inválida. Entre novamente.");
  }
  const cache = CacheService.getScriptCache();
  const cacheKey = "tok_" + sha256Hex_(token);
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const response = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) throw new GatewayError_(401, "Sessão expirada. Entre novamente.");

  const info = JSON.parse(response.getContentText());
  const audience = info.aud || info.azp;
  if (audience !== GATEWAY_CONFIG.CLIENT_ID) throw new GatewayError_(401, "Sessão inválida.");
  if (!info.email || String(info.email_verified) !== "true") throw new GatewayError_(401, "E-mail não verificado.");

  const email = String(info.email).trim().toLowerCase();
  const ttl = Math.min(300, Number(info.expires_in) || 0);
  if (ttl > 10) cache.put(cacheKey, email, ttl);
  return email;
}

// ---------------------------------------------------------------------------
// Request handling — pure logic over injected dependencies (unit-testable)
// ---------------------------------------------------------------------------

// Every company the gateway knows: the ones fixed in GATEWAY_CONFIG plus the
// ones created from inside the app (registry).
function companyMap_(deps) {
  const map = {};
  Object.keys(deps.config.SPREADSHEETS).forEach((id) => {
    map[id] = deps.config.SPREADSHEETS[id];
  });
  const registered = deps.registry ? deps.registry.list() : [];
  registered.forEach((entry) => {
    if (!map[entry.spreadsheetId]) map[entry.spreadsheetId] = { empresa: entry.empresa, sheetName: entry.sheetName || "Lançamento", segmento: segmentoValido_(entry.segmento) };
  });
  return map;
}

function handleRequest(body, deps) {
  if (!body || typeof body !== "object") throw new GatewayError_(400, "Requisição inválida.");
  if (PW_PUBLIC_ACTIONS.indexOf(body.action) !== -1) return despacharPublico_(body, deps);
  // Two kinds of proof: a Google token (checked with Google) or a session of the
  // e-mail + password login ("fs1.…", signed by this script).
  const sessaoSenha = typeof body.token === "string" && body.token.indexOf("fs1.") === 0;
  const email = sessaoSenha ? verificarSessaoSenha_(deps, body.token) : deps.verifyToken(body.token);
  try {
    return despachar_(body, deps, email, sessaoSenha);
  } catch (err) {
    if (err instanceof GatewayError_) throw err;
    console.error(err);
    // Only reached AFTER the caller proved who they are: a short, sanitised reason
    // (e.g. "The caller does not have permission") makes real problems diagnosable
    // instead of a blank "internal error".
    throw new GatewayError_(500, "Erro interno no servidor do app. Detalhe: " + detalheSeguro_(err));
  }
}

function detalheSeguro_(err) {
  let texto = String(err && err.message ? err.message : err);
  texto = texto.replace(/[\r\n]+/g, " ").replace(/[A-Za-z0-9_-]{40,}/g, "…").trim();
  return texto.length > 220 ? texto.slice(0, 220) + "…" : texto;
}

function despachar_(body, deps, email, sessaoSenha) {
  const action = body.action;

  if (action === "pwTrocarSenha") return acaoPwTrocarSenha_(deps, email, sessaoSenha, body);
  if (action === "pwListar") return acaoPwListar_(deps, email);
  if (action === "pwDecidir") return acaoPwDecidir_(deps, email, body);
  if (action === "completarCadastroAutorizado") return actionCompletarCadastro_(deps, email, sessaoSenha, body);
  if (action === "registrarPush") return actionRegistrarPush_(deps, email, body);
  if (action === "me") return actionMe_(deps, email);
  if (action === "createCompany") return actionCreateCompany_(deps, email, body);
  if (action === "requestAccess") return actionRequestAccess_(deps, email, body);
  if (action === "listRequests") return actionListRequests_(deps, email);
  if (action === "resolveRequest") return actionResolveRequest_(deps, email, body);
  if (action === "listCompanies") return actionListCompanies_(deps, email);
  if (action === "forwardRequest") return actionForwardRequest_(deps, email, body);
  if (action === "setCompanyActive") return actionSetCompanyActive_(deps, email, body);

  // Own keys only: "constructor" / "__proto__" / "toString" must not pass as a company id.
  const map = companyMap_(deps);
  const spreadsheet =
    typeof body.spreadsheetId === "string" && Object.prototype.hasOwnProperty.call(map, body.spreadsheetId) ? map[body.spreadsheetId] : null;
  if (!spreadsheet) throw new GatewayError_(403, "Empresa não permitida.");
  const access = getAccess_(deps, email, body.spreadsheetId);

  switch (action) {
    case "getTitles":
      if (!access.perfil && !access.bootstrapOk) throw denied_();
      return { titles: titlesFor_(deps, access, spreadsheet, body.spreadsheetId) };
    case "getValues":
      return actionGetValues_(deps, access, spreadsheet, body);
    case "updateValues":
      return actionUpdateValues_(deps, email, access, spreadsheet, body);
    case "addTab":
      return actionAddTab_(deps, access, body);
    case "verificarLembretes":
      return actionVerificarLembretes_(deps, access, spreadsheet, body);
    default:
      throw new GatewayError_(400, "Ação desconhecida.");
  }
}

// Tab names are company information too: everyone but the Master (and the
// first-setup admin) only sees the tabs the app may use for them.
function titlesFor_(deps, access, spreadsheet, spreadsheetId) {
  const all = deps.sheets.getTitles(spreadsheetId);
  if (access.perfil === ROLE_MASTER || access.bootstrapOk) return all;
  const cfg = loadConfigTabs_(deps, spreadsheetId);
  return all.filter(
    (t) =>
      t === USUARIOS_TAB || // its existence is not a secret (the app checks it at every sign-in); its CONTENT stays Master-only
      READ_TABS.indexOf(t) !== -1 ||
      t === spreadsheet.sheetName ||
      t === CONFIG_TAB ||
      t === cfg.lancamentos ||
      t === cfg.estoque ||
      cfg.listas.indexOf(t) !== -1
  );
}

function denied_() {
  return new GatewayError_(403, "Você não tem permissão para esta ação.");
}

// ---------------------------------------------------------------------------
// E-mails. The same person can be typed in the Usuários tab in many ways: capital
// letters, a stray space or invisible character copied from a chat/e-mail,
// "mailto:", "<a@b.com>", or — for Gmail — with dots in other places
// (maria.teste@ = mariateste@ = Maria.Teste@GMAIL.com: Google treats them
// as ONE account, and googlemail.com is the same as gmail.com). Access is decided
// by a canonical key, so a correct-looking entry never locks someone out.
// Only Gmail is folded like that; on any other domain dots stay significant.
// ---------------------------------------------------------------------------

function limparEmail_(valor) {
  if (typeof valor !== "string") return "";
  let v = valor.normalize ? valor.normalize("NFKC") : valor;
  v = v.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\u00A0/g, " ").trim().toLowerCase();
  v = v.replace(/^mailto:/, "");
  const entre = v.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (entre) v = entre[1];
  return v.trim();
}

function canonEmail_(valor) {
  const v = limparEmail_(valor);
  const arroba = v.lastIndexOf("@");
  if (arroba < 1) return v;
  let local = v.slice(0, arroba);
  let dominio = v.slice(arroba + 1);
  if (dominio === "gmail.com" || dominio === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    dominio = "gmail.com";
  }
  return local + "@" + dominio;
}

function normalizeRole_(value) {
  return VALID_ROLES.indexOf(value) !== -1 ? value : ROLE_VISUALIZADOR;
}

function isAdminEmail_(deps, email) {
  const chave = canonEmail_(email);
  return deps.config.ADMIN_EMAILS.some((a) => canonEmail_(a) === chave);
}

// Reads a company's Usuários tab (short cache). null = the tab doesn't exist.
// A single read: asking for a tab that isn't there makes the Sheets API fail,
// which is exactly the "missing" answer (this runs once per company on every
// sign-in, so the extra "list the tabs" call it replaced was costly).
function loadUsuarios_(deps, spreadsheetId) {
  const cacheKey = "usr_" + spreadsheetId;
  const cached = deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  let rows;
  try {
    rows = deps.sheets.getValues(spreadsheetId, USUARIOS_TAB + "!A2:C", "UNFORMATTED_VALUE");
  } catch (err) {
    return null;
  }
  const usuarios = [];
  rows.forEach((row, index) => {
    if (typeof row[0] !== "string" || !limparEmail_(row[0])) return;
    usuarios.push({
      linha: index + 2,
      email: limparEmail_(row[0]),
      chave: canonEmail_(row[0]),
      nome: row[1] ? String(row[1]) : "",
      perfil: normalizeRole_(row[2]),
    });
  });
  deps.cache.put(cacheKey, JSON.stringify(usuarios), USUARIOS_CACHE_SECONDS);
  return usuarios;
}

// Reads the company's Configuração tab (short cache). Always returns a usable
// object: a missing / unreadable / hostile tab means "no configuration".
function loadConfigTabs_(deps, spreadsheetId) {
  const cacheKey = "cfg_" + spreadsheetId;
  const cached = deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const out = { lancamentos: null, estoque: null, listas: [] };
  let rows = [];
  try {
    rows = deps.sheets.getValues(spreadsheetId, CONFIG_TAB + "!A2:B" + (MAX_CONFIG_ROWS + 1), "UNFORMATTED_VALUE");
  } catch (err) {
    rows = [];
  }
  rows.slice(0, MAX_CONFIG_ROWS).forEach((row) => {
    const papel = typeof row[0] === "string" ? row[0].trim() : "";
    const aba = typeof row[1] === "string" ? row[1].trim() : "";
    if (!papel || !aba || aba.length > 100 || aba === USUARIOS_TAB || aba === CONFIG_TAB || aba === FISCAL_TAB) return;
    if (CONFIG_ROLES.indexOf(papel) !== -1) out[papel] = aba;
    else if (papel.indexOf("lista:") === 0 && CONFIG_LIST_KEYS.indexOf(papel.slice(6)) !== -1) out.listas.push(aba);
  });
  deps.cache.put(cacheKey, JSON.stringify(out), USUARIOS_CACHE_SECONDS);
  return out;
}

function getAccess_(deps, email, spreadsheetId) {
  const usuarios = loadUsuarios_(deps, spreadsheetId);
  const chave = canonEmail_(email);
  const entry = usuarios ? usuarios.filter((u) => (u.chave || canonEmail_(u.email)) === chave)[0] : null;
  const empty = usuarios === null || usuarios.length === 0;
  return {
    entry: entry || null,
    perfil: entry ? entry.perfil : null,
    usuarios: usuarios || [],
    bootstrapOk: empty && isAdminEmail_(deps, email),
  };
}

// Is this e-mail already listed in SOME company's Usuários tab? Used by the
// e-mail + password login so a person a company Master has already
// authorized (for Google sign-in) does not also have to wait for the system
// administrator's separate approval to get a password — the Master's own
// act of adding them already is the approval. A company that fails to read
// is skipped, not treated as a match.
// The index (see "E-mail -> empresa index" above) only ever NARROWS which
// companies get a live Usuários read — it is never trusted on its own for a
// yes/no answer, so a stale or empty index can only make this slower (fall
// back to every company), never say "authorized" about someone who isn't.
function autorizadoEmAlgumaEmpresa_(deps, canon) {
  const empresas = companyMap_(deps);
  const candidatos = deps.indiceEmails ? deps.indiceEmails.listarEmpresasDoEmail(canon).filter((id) => empresas[id]) : [];
  const ids = candidatos.length ? candidatos : Object.keys(empresas);
  return ids.some((id) => {
    try {
      return (loadUsuarios_(deps, id) || []).some((u) => u.chave === canon);
    } catch (err) {
      return false;
    }
  });
}

function actionMe_(deps, email) {
  const companies = [];
  const bootstrap = [];
  const known = companyMap_(deps);
  const canon = canonEmail_(email);
  // Admins always get the full scan: bootstrap (finding an EMPTY company to
  // found) has no index entry to find by definition — nobody is listed yet.
  // Everyone else only ever needs the companies the index already knows
  // about them being in; an empty/stale result falls back to the full scan
  // for correctness, and that fallback self-heals the index for next time
  // (see the "Deploy safety" note on the index block above).
  const admin = isAdminEmail_(deps, email);
  const candidatosIndice = deps.indiceEmails ? deps.indiceEmails.listarEmpresasDoEmail(canon).filter((id) => known[id]) : [];
  const varreduraCompleta = admin || candidatosIndice.length === 0;
  const idsParaChecar = varreduraCompleta ? Object.keys(known) : candidatosIndice;

  idsParaChecar.forEach((spreadsheetId) => {
    const info = known[spreadsheetId];
    let access;
    try {
      access = getAccess_(deps, email, spreadsheetId);
    } catch (err) {
      return; // an unreadable company simply isn't offered
    }
    if (access.entry) {
      companies.push({
        spreadsheetId: spreadsheetId,
        empresa: info.empresa,
        sheetName: info.sheetName,
        segmento: segmentoValido_(info.segmento),
        nome: access.entry.nome,
        perfil: access.entry.perfil,
        linha: access.entry.linha,
      });
      // Self-heal: only reached via the full-scan fallback (the indexed path
      // only ever visits companies already in the index), so this is the
      // index catching up, never duplicate work on the fast path.
      if (varreduraCompleta && !admin && deps.indiceEmails) deps.indiceEmails.adicionar(canon, spreadsheetId);
    } else if (access.bootstrapOk) {
      bootstrap.push({ spreadsheetId: spreadsheetId, empresa: info.empresa, sheetName: info.sheetName, segmento: segmentoValido_(info.segmento) });
    }
  });
  // Whether this e-mail already has an ACTIVE e-mail+senha login: a signed-in
  // Google session with no password yet is offered the chance to create one
  // (see "completarCadastroAutorizado"); someone who already has a password
  // is never asked again.
  const loginSenha = deps.logins ? acharLogin_(deps, canonEmail_(email)) : null;
  const result = {
    companies: companies,
    bootstrap: bootstrap,
    superAdmin: isAdminEmail_(deps, email),
    temSenhaAtiva: Boolean(loginSenha && loginSenha.c[LG.SIT] === SIT.ATIVO),
  };
  if (result.superAdmin && deps.requests) {
    result.pedidosPendentes = deps.requests.list().filter((r) => r.status === "Pendente").length;
  }
  if (companies.length === 0 && bootstrap.length === 0 && deps.requests) {
    const mine = deps.requests.list().filter((r) => canonEmail_(r.email) === canonEmail_(email));
    const last = mine[mine.length - 1];
    if (last) result.pedido = { status: last.status, empresa: last.empresa, data: last.data };
  }
  return result;
}

// Only the system administrators (ADMIN_EMAILS) can create a company. The new
// spreadsheet is created by this script, so it belongs to the account that
// deployed it; nobody needs it shared in Drive.
function actionCreateCompany_(deps, email, body) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const nome = typeof body.nome === "string" ? body.nome.trim() : "";
  const ownerEmail = limparEmail_(body.ownerEmail);
  const ownerNome = typeof body.ownerNome === "string" ? body.ownerNome.trim() : "";
  if (body.segmento !== undefined && (typeof body.segmento !== "string" || !Object.prototype.hasOwnProperty.call(SEGMENTOS, body.segmento))) {
    throw new GatewayError_(400, "Segmento inválido.");
  }
  const segmento = segmentoValido_(body.segmento);
  if (!nome || nome.length > 80) throw new GatewayError_(400, "Informe o nome da empresa (até 80 letras).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || ownerEmail.length > 120) throw new GatewayError_(400, "Informe um e-mail válido para o administrador da empresa.");
  if (!ownerNome || ownerNome.length > 80) throw new GatewayError_(400, "Informe o nome do administrador da empresa.");

  const known = companyMap_(deps);
  const ids = Object.keys(known);
  if (ids.length >= MAX_COMPANIES) throw new GatewayError_(400, "Limite de empresas atingido.");
  if (ids.some((id) => String(known[id].empresa).trim().toLowerCase() === nome.toLowerCase())) {
    throw new GatewayError_(400, "Já existe uma empresa com esse nome.");
  }

  return deps.lock(() => {
    const spreadsheetId = deps.sheets.createCompanySpreadsheet(nome + " — Finan.", nome, segmento);
    const rows = [[ownerEmail, ownerNome, ROLE_MASTER]];
    // Separation of duties: the system administrator only enters a company's
    // data if they explicitly ask for it (support). Default: not a member.
    if (body.incluirMeuAcesso === true && canonEmail_(email) !== canonEmail_(ownerEmail)) rows.push([email, "Administrador do sistema", ROLE_MASTER]);
    rows.forEach((row, i) => {
      deps.sheets.updateValues(spreadsheetId, USUARIOS_TAB + "!A" + (i + 2) + ":C" + (i + 2), [row]);
    });
    deps.registry.add({ spreadsheetId: spreadsheetId, empresa: nome, criadaPor: email, segmento: segmento });
    deps.cache.remove("usr_" + spreadsheetId);
    reindexarEmpresaUsuarios_(deps, spreadsheetId);
    return { spreadsheetId: spreadsheetId, empresa: nome, sheetName: "Lançamento", segmento: segmento };
  });
}

// Text typed by a stranger ends up in a spreadsheet and in an e-mail: keep it
// plain (no control characters, no line breaks in short fields).
function cleanText_(value, max, allowNewlines) {
  if (typeof value !== "string") return "";
  let v = value.replace(allowNewlines ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f]/g : /[\u0000-\u001f]/g, " ");
  v = v.trim();
  return v.length > max ? v.slice(0, max) : v;
}

// Anyone with a verified Google account may ask for access — that is the whole
// point — so this is deliberately limited: one pending request per e-mail, a
// per-address cool-down, a cap on the pending pile, and short plain-text fields.
function actionRequestAccess_(deps, email, body) {
  if (!deps.requests) throw new GatewayError_(400, "Ação indisponível.");
  const nome = cleanText_(body.nome, 80, false);
  const empresa = cleanText_(body.empresa, 80, false);
  const mensagem = cleanText_(body.mensagem, 500, true);
  const tipo = REQUEST_TYPES.indexOf(body.tipo) !== -1 ? body.tipo : "";
  if (!nome) throw new GatewayError_(400, "Informe o seu nome.");
  if (!empresa) throw new GatewayError_(400, "Informe o nome da empresa.");
  if (!tipo) throw new GatewayError_(400, "Escolha o tipo de pedido.");

  const cooldownKey = "reqcool_" + canonEmail_(email);
  if (deps.cache.get(cooldownKey)) throw new GatewayError_(429, "Aguarde um minuto antes de enviar outro pedido.");

  return deps.lock(() => {
    const all = deps.requests.list();
    if (all.some((r) => canonEmail_(r.email) === canonEmail_(email) && r.status === "Pendente")) return { duplicate: true };
    if (all.filter((r) => r.status === "Pendente").length >= MAX_PENDING_REQUESTS) {
      throw new GatewayError_(503, "Muitos pedidos em análise. Tente mais tarde.");
    }
    deps.requests.add({ email: email, nome: nome, empresa: empresa, tipo: tipo, mensagem: mensagem });
    deps.cache.put(cooldownKey, "1", 60);

    // Best effort: a mail problem must never lose the request (it is saved above).
    try {
      deps.mail.send({
        to: deps.config.ADMIN_EMAILS.join(","),
        subject: "Finan.: pedido de acesso de " + nome,
        body:
          "Novo pedido de acesso ao Finan.\n\n" +
          "Nome: " + nome + "\n" +
          "E-mail: " + email + "\n" +
          "Empresa: " + empresa + "\n" +
          "Tipo: " + (tipo === "nova" ? "quer usar o Finan. na própria empresa" : "trabalha em uma empresa que já usa") + "\n" +
          "Mensagem: " + (mensagem || "(sem mensagem)") + "\n\n" +
          "Para responder, entre em " + deps.config.APP_URL + " e abra o Painel do sistema.",
      });
    } catch (err) {
      console.error(err);
    }
    return { duplicate: false };
  });
}

function actionListRequests_(deps, email) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const all = deps.requests ? deps.requests.list() : [];
  const pendentes = all.filter((r) => r.status === "Pendente");
  const recentes = all.filter((r) => r.status !== "Pendente").slice(-20);
  return { pendentes: pendentes, recentes: recentes };
}

// The administrator marks a request as handled (approved or declined). The
// actual granting (creating the company / adding the person) uses the existing,
// separately-checked actions; this only records the outcome and, unless told
// not to, e-mails the requester.
function actionResolveRequest_(deps, email, body) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const linha = Number(body.linha);
  const status = body.status;
  if (!Number.isInteger(linha) || linha < 2) throw new GatewayError_(400, "Pedido inválido.");
  if (status !== "Atendida" && status !== "Recusada") throw new GatewayError_(400, "Situação inválida.");
  const nota = cleanText_(body.nota, 200, false);

  return deps.lock(() => {
    const pedido = deps.requests.list().filter((r) => r.linha === linha)[0];
    if (!pedido) throw new GatewayError_(400, "Pedido não encontrado.");
    if (pedido.status !== "Pendente") throw new GatewayError_(400, "Esse pedido já foi respondido.");
    deps.requests.setStatus(linha, status, nota);
    if (body.avisar !== false) {
      try {
        deps.mail.send({
          to: pedido.email,
          subject: status === "Atendida" ? "Finan.: seu acesso foi liberado" : "Finan.: sobre o seu pedido de acesso",
          body:
            status === "Atendida"
              ? "Olá, " + pedido.nome + ".\n\nSeu acesso ao Finan. foi liberado. Entre com esta mesma conta Google (" + pedido.email + ") em " + deps.config.APP_URL + "\n"
              : "Olá, " + pedido.nome + ".\n\nNão foi possível liberar o seu acesso ao Finan. agora." + (nota ? "\n\n" + nota : "") + "\n",
        });
      } catch (err) {
        console.error(err);
      }
    }
    return { resolved: true };
  });
}

// Administrative overview for the system console: which companies exist, how
// many people each has and who their Master(s) are. No business data (no
// lançamentos, no estoque) is ever returned here.
// Lists EVERY company the admin can manage, active or not — unlike every
// other place that reads companies (companyMap_), which only ever sees
// active ones. A deactivated company still needs to show up here (with
// ativa: false), or there would be no way to find and reactivate it again.
function actionListCompanies_(deps, email) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const fixed = deps.config.SPREADSHEETS;
  const entries = {};
  Object.keys(fixed).forEach((id) => {
    entries[id] = { empresa: fixed[id].empresa, segmento: segmentoValido_(fixed[id].segmento), origem: "fixa", ativa: true };
  });
  const registradas = deps.registry && deps.registry.listAll ? deps.registry.listAll() : [];
  registradas.forEach((c) => {
    if (!Object.prototype.hasOwnProperty.call(entries, c.spreadsheetId)) {
      entries[c.spreadsheetId] = { empresa: c.empresa, segmento: c.segmento, origem: "criada", ativa: c.ativa };
    }
  });
  const out = Object.keys(entries)
    .slice(0, MAX_COMPANIES)
    .map((spreadsheetId) => {
      const info = entries[spreadsheetId];
      let usuarios = null;
      try {
        usuarios = loadUsuarios_(deps, spreadsheetId);
      } catch (err) {
        usuarios = null;
      }
      const list = usuarios || [];
      return {
        spreadsheetId: spreadsheetId,
        empresa: info.empresa,
        segmento: info.segmento,
        origem: info.origem,
        ativa: info.ativa,
        usuarios: list.length,
        masters: list.filter((u) => u.perfil === ROLE_MASTER).map((u) => ({ nome: u.nome, email: u.email })),
      };
    });
  return { empresas: out };
}

// Soft "excluir empresa" — see registryDeps_.setActive's own comment for why
// this is a deactivation (reversible), not a real delete: the spreadsheet
// and its data are untouched, only the registry's own "Ativa" flag flips, and
// companyMap_ (hence every other gateway action) stops seeing that company
// at all from that point on. A "fixa" company (hardcoded in
// GATEWAY_CONFIG.SPREADSHEETS — Ipanema, Carolina today) has no registry row
// to flip, so this is refused for those with a message explaining why; that
// is a deliberate, rarer, code-level change, not a button in this screen.
function actionSetCompanyActive_(deps, email, body) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const spreadsheetId = typeof body.spreadsheetId === "string" ? body.spreadsheetId : "";
  if (!spreadsheetId) throw new GatewayError_(400, "Empresa inválida.");
  if (Object.prototype.hasOwnProperty.call(deps.config.SPREADSHEETS, spreadsheetId)) {
    throw new GatewayError_(400, "Essa empresa está fixa no código do servidor e não pode ser excluída por aqui.");
  }
  if (!deps.registry || !deps.registry.setActive) throw new GatewayError_(400, "Ação indisponível.");
  const ativa = body.ativa === true;
  return deps.lock(() => {
    const achou = deps.registry.setActive(spreadsheetId, ativa);
    if (!achou) throw new GatewayError_(400, "Empresa não encontrada no registro.");
    return { ativa: ativa };
  });
}

// A person who says they work at a company that already uses the app is not
// the system administrator's to approve: the request is e-mailed to that
// company's own Master(s), who register the person in their own Ajustes.
function actionForwardRequest_(deps, email, body) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const linha = Number(body.linha);
  if (!Number.isInteger(linha) || linha < 2) throw new GatewayError_(400, "Pedido inválido.");
  // Own keys only, same guard as despachar_'s own company lookup: a bare `map[id]`
  // on "__proto__"/"constructor"/"toString" returns a truthy Object.prototype
  // value instead of undefined, which would pass the `!company` check below.
  // Only ADMIN_EMAILS reach this action, so this is defense-in-depth, not a
  // closed hole an outside attacker could already reach.
  const companyMapNow = companyMap_(deps);
  const company = typeof body.spreadsheetId === "string" && Object.prototype.hasOwnProperty.call(companyMapNow, body.spreadsheetId) ? companyMapNow[body.spreadsheetId] : null;
  if (!company) throw new GatewayError_(400, "Empresa não encontrada.");

  return deps.lock(() => {
    const pedido = deps.requests.list().filter((r) => r.linha === linha)[0];
    if (!pedido) throw new GatewayError_(400, "Pedido não encontrado.");
    if (pedido.status !== "Pendente") throw new GatewayError_(400, "Esse pedido já foi respondido.");
    const masters = (loadUsuarios_(deps, body.spreadsheetId) || []).filter((u) => u.perfil === ROLE_MASTER);
    if (masters.length === 0) throw new GatewayError_(400, "Essa empresa não tem um administrador cadastrado.");

    deps.requests.setStatus(linha, "Encaminhada", "Encaminhado para " + company.empresa);
    try {
      deps.mail.send({
        to: masters.map((m) => m.email).join(","),
        subject: "Finan.: " + pedido.nome + " pediu acesso à " + company.empresa,
        body:
          pedido.nome + " (" + pedido.email + ") pediu acesso ao Finan. como pessoa da empresa " + company.empresa + ".\n\n" +
          "Mensagem: " + (pedido.mensagem || "(sem mensagem)") + "\n\n" +
          "Se você reconhece essa pessoa e quer liberar, entre em " + deps.config.APP_URL +
          " e abra Ajustes > Adicionar usuário, informando este e-mail e o perfil desejado. Se não reconhece, ignore esta mensagem.",
      });
      deps.mail.send({
        to: pedido.email,
        subject: "Finan.: seu pedido foi encaminhado",
        body: "Olá, " + pedido.nome + ".\n\nSeu pedido foi encaminhado ao administrador da empresa " + company.empresa + ", que decide quem tem acesso. Quando ele cadastrar o seu e-mail, é só entrar em " + deps.config.APP_URL + " com esta conta Google.\n",
      });
    } catch (err) {
      console.error(err);
    }
    return { forwarded: true, para: masters.length };
  });
}

// "Tab!A2:J" or "'Tipo de Produto'!A2:D" -> { tab, cells }. Anything else is refused.
function parseRange_(range) {
  if (typeof range !== "string" || range.length > 100) throw new GatewayError_(400, "Intervalo inválido.");
  const match = range.match(/^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Za-z]{1,3}[0-9]{0,6}(?::[A-Za-z]{1,3}[0-9]{0,6})?)$/);
  if (!match) throw new GatewayError_(400, "Intervalo inválido.");
  const tab = match[1] ? match[1].replace(/''/g, "'") : match[2];
  return { tab: tab, cells: match[3].toUpperCase() };
}

function actionGetValues_(deps, access, spreadsheet, body) {
  const parsed = parseRange_(body.range);
  if (parsed.tab === USUARIOS_TAB) {
    // The full user list is admin data (the app reads the caller's own row via "me").
    if (access.perfil !== ROLE_MASTER && !access.bootstrapOk) throw denied_();
  } else if (parsed.tab === FISCAL_TAB) {
    // Always Master-only to read, checked by tab name directly — mirrors the
    // write-side check below and never consults loadConfigTabs_ at all. This
    // holds even if a Configuração row somehow names this tab for another
    // role (a Master's mistake, or a row saved before loadConfigTabs_/
    // validConfigRow_ started excluding FISCAL_TAB): the fiscal credentials
    // can never become readable to anyone but the Master through that path.
    if (access.perfil !== ROLE_MASTER) throw denied_();
  } else {
    if (!access.perfil) throw denied_();
    const cfg = loadConfigTabs_(deps, body.spreadsheetId);
    const readable =
      READ_TABS.indexOf(parsed.tab) !== -1 ||
      parsed.tab === spreadsheet.sheetName ||
      parsed.tab === CONFIG_TAB ||
      parsed.tab === cfg.lancamentos ||
      parsed.tab === cfg.estoque ||
      cfg.listas.indexOf(parsed.tab) !== -1;
    // The Master may read ANY tab: it is how they connect a sheet whose tabs have other names.
    if (!readable && access.perfil !== ROLE_MASTER) throw denied_();
  }
  const option = body.valueRenderOption === "UNFORMATTED_VALUE" ? "UNFORMATTED_VALUE" : null;
  return { values: deps.sheets.getValues(body.spreadsheetId, body.range, option) };
}

function validateRow_(values) {
  if (!Array.isArray(values) || values.length !== 1 || !Array.isArray(values[0])) {
    throw new GatewayError_(400, "Dados inválidos.");
  }
  const row = values[0];
  if (row.length > MAX_ROW_CELLS) throw new GatewayError_(400, "Dados inválidos.");
  row.forEach((cell) => {
    const type = typeof cell;
    if (cell === null || type === "number" || type === "boolean") return;
    if (type === "string" && cell.length <= MAX_CELL_CHARS) return;
    throw new GatewayError_(400, "Dados inválidos.");
  });
  return row;
}

function actionUpdateValues_(deps, email, access, spreadsheet, body) {
  const parsed = parseRange_(body.range);
  const row = validateRow_(body.values);
  const canEdit = access.perfil === ROLE_EDITOR || access.perfil === ROLE_MASTER;

  if (parsed.tab === USUARIOS_TAB) {
    if (!canWriteUsuarios_(access, email, parsed, row)) throw denied_();
  } else if (parsed.tab === CONFIG_TAB) {
    if (access.perfil !== ROLE_MASTER || !validConfigRow_(parsed, row)) throw denied_();
  } else if (parsed.tab === FISCAL_TAB) {
    if (access.perfil !== ROLE_MASTER || !validFiscalRow_(parsed, row)) throw denied_();
  } else {
    const cfg = loadConfigTabs_(deps, body.spreadsheetId);
    const isLookup = LOOKUP_TABS.indexOf(parsed.tab) !== -1 || cfg.listas.indexOf(parsed.tab) !== -1;
    const writable =
      WRITE_TABS.indexOf(parsed.tab) !== -1 ||
      parsed.tab === spreadsheet.sheetName ||
      parsed.tab === cfg.lancamentos ||
      parsed.tab === cfg.estoque;
    // The support lists (lojas, contas, categorias...) are edited by the company's Master only.
    if (isLookup) {
      if (access.perfil !== ROLE_MASTER) throw denied_();
    } else if (!writable || !canEdit) {
      throw denied_();
    }
  }

  return deps.lock(() => {
    deps.sheets.updateValues(body.spreadsheetId, body.range, [row]);
    if (parsed.tab === USUARIOS_TAB) {
      deps.cache.remove("usr_" + body.spreadsheetId);
      reindexarEmpresaUsuarios_(deps, body.spreadsheetId);
    }
    if (parsed.tab === CONFIG_TAB) deps.cache.remove("cfg_" + body.spreadsheetId);
    return { updated: true };
  });
}

// One Configuração row: the header, or "papel, aba" with a known role and a
// tab name that is not one of the protected tabs.
function validConfigRow_(parsed, row) {
  if (!/^A[0-9]{1,3}:B[0-9]{1,3}$/.test(parsed.cells) && !/^A[0-9]{1,3}:C[0-9]{1,3}$/.test(parsed.cells)) return false;
  if (row.length < 2 || row.length > 3) return false;
  if (parsed.cells === "A1:B1" || parsed.cells === "A1:C1") return row[0] === "Papel" && row[1] === "Aba";
  const n = Number(/^A([0-9]+)/.exec(parsed.cells)[1]);
  if (n < 2 || n > MAX_CONFIG_ROWS + 1) return false;
  const papel = row[0];
  const aba = row[1];
  if (papel === "" && aba === "") return true; // clearing a row
  if (typeof papel !== "string" || typeof aba !== "string") return false;
  if (aba.trim() === "" || aba.length > 100 || aba === USUARIOS_TAB || aba === CONFIG_TAB || aba === FISCAL_TAB) return false;
  const okPapel = CONFIG_ROLES.indexOf(papel) !== -1 || (papel.indexOf("lista:") === 0 && CONFIG_LIST_KEYS.indexOf(papel.slice(6)) !== -1);
  return okPapel;
}

// Configuração Fiscal: always exactly 5 cells, either the header row (A1:E1)
// or the one data row (A2:E2) — there is no "next empty row" scan for this
// tab, it never grows past one row. The real security boundary is the
// Master-only role check right before this call, not this shape check; this
// is only basic sanity (same spirit as validConfigRow_ above), not a
// provider-specific validation, since no provider has been chosen yet.
function validFiscalRow_(parsed, row) {
  if (parsed.cells !== "A1:E1" && parsed.cells !== "A2:E2") return false;
  if (row.length !== 5) return false;
  return row.every((v) => typeof v === "string" && v.length <= 500);
}

// Usuários writes: a Master may write anywhere on the tab; the very first
// setup of a company (empty tab, admin email) may only write its own Master
// row + the header; anyone else may only rename THEMSELVES (their own Nome cell).
function canWriteUsuarios_(access, email, parsed, row) {
  if (access.perfil === ROLE_MASTER) return true;

  if (access.bootstrapOk) {
    if (/^A1:C1$/.test(parsed.cells)) {
      return row.length === 3 && row[0] === "Email" && row[1] === "Nome" && row[2] === "Perfil";
    }
    return (
      /^A[0-9]+:C[0-9]+$/.test(parsed.cells) &&
      row.length === 3 &&
      canonEmail_(row[0]) === canonEmail_(email) &&
      row[2] === ROLE_MASTER
    );
  }

  const own = /^B([0-9]+):B\1$/.exec(parsed.cells);
  if (own && access.entry && row.length === 1 && typeof row[0] === "string") {
    return Number(own[1]) === access.entry.linha;
  }
  return false;
}

function actionAddTab_(deps, access, body) {
  const erpTab = ERP_MASTER_ONLY_TABS.indexOf(body.title) !== -1;
  if (body.title !== USUARIOS_TAB && body.title !== CONFIG_TAB && !erpTab) throw denied_();
  if (body.title === CONFIG_TAB || erpTab) {
    // Creating the tab is a structural change, kept Master-only even though
    // Editor can write rows in it once it exists (every ERP_MASTER_ONLY_TABS
    // entry is also in WRITE_TABS) — same reasoning as Configuração.
    if (access.perfil !== ROLE_MASTER) throw denied_();
  } else if (access.perfil !== ROLE_MASTER && !access.bootstrapOk) {
    throw denied_();
  }
  return deps.lock(() => {
    deps.sheets.addTab(body.spreadsheetId, body.title);
    if (body.title === USUARIOS_TAB) deps.cache.remove("usr_" + body.spreadsheetId);
    else if (body.title === CONFIG_TAB) deps.cache.remove("cfg_" + body.spreadsheetId);
    return { created: true };
  });
}

// ---------------------------------------------------------------------------
// ERP, Fase 1 — avisos de vencimento (Contas a Pagar / Contas a Receber).
// Called once per login by the client (never on a timer: this app has no
// background trigger installed) — so this is "checked whenever someone who
// can act signs in," not a true any-time-of-day push. Deliberately dedupes
// via each row's own "Avisado em" column (column J, index 9) rather than a
// cache key, so it is correct even across logins from different people/devices
// and survives the 20 s Usuários-style cache window with no special-casing.
// ---------------------------------------------------------------------------

const CONTAS_AVISO_DIAS_ANTES = 3;
const LEMBRETE_COL = { DESCRICAO: 0, CONTRAPARTE: 1, VALOR: 3, VENCIMENTO: 4, STATUS: 5, AVISADO: 9 };

function hojeSerial_(deps) {
  const epoch = Date.UTC(1899, 11, 30);
  return Math.floor((deps.now() - epoch) / 86400000);
}

function formatarDataSerial_(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const dia = ("0" + d.getUTCDate()).slice(-2);
  const mes = ("0" + (d.getUTCMonth() + 1)).slice(-2);
  return dia + "/" + mes + "/" + d.getUTCFullYear();
}

function formatarMoeda_(valor) {
  return "R$ " + (Number(valor) || 0).toFixed(2).replace(".", ",");
}

function montarCorpoLembretes_(empresa, pendentes, hoje) {
  function linhas(itens) {
    return itens
      .map((it) => {
        const tag = it.vencimento < hoje ? "ATRASADA" : "vence em " + formatarDataSerial_(it.vencimento);
        return "- " + it.descricao + " (" + it.contraparte + "), " + formatarMoeda_(it.valor) + " — " + tag;
      })
      .join("\n");
  }
  const partes = ["Olá!\n\nUm resumo das contas de " + empresa + " que precisam de atenção:\n"];
  if (pendentes.pagar.length) partes.push("\nA PAGAR:\n" + linhas(pendentes.pagar));
  if (pendentes.receber.length) partes.push("\nA RECEBER:\n" + linhas(pendentes.receber));
  partes.push("\n\nEntre no Finan. para ver os detalhes.\n");
  return partes.join("");
}

// A push notification has little room (and no "ver tabela" to open) — short,
// just enough to make someone tap it and open the app.
function montarCorpoPush_(pendentes) {
  const total = pendentes.pagar.length + pendentes.receber.length;
  const primeira = pendentes.pagar[0] || pendentes.receber[0];
  if (total === 1 && primeira) return primeira.descricao + " — toque para ver.";
  return "Toque para ver os detalhes no Finan.";
}

// The actual scan-and-mail work, with no notion of "who is asking" — shared
// by the per-login path (actionVerificarLembretes_, role-gated below) and the
// daily time-based trigger (verificarLembretesTodasEmpresasAgendado, which has
// no caller to gate: it IS the system). Dedup is per-row ("Avisado em"), so
// calling this twice in the same day (once from a login, once from the
// trigger) never double-mails — the second call just finds nothing left to do.
function executarVerificacaoLembretes_(deps, spreadsheetId, empresaNome) {
  const hoje = hojeSerial_(deps);
  const limite = hoje + CONTAS_AVISO_DIAS_ANTES;
  const pendentes = { pagar: [], receber: [] };

  [CONTAS_PAGAR_TAB, CONTAS_RECEBER_TAB].forEach((tab) => {
    let rows;
    try {
      rows = deps.sheets.getValues(spreadsheetId, "'" + tab + "'!A2:J", "UNFORMATTED_VALUE");
    } catch (err) {
      return; // tab not created yet on this company — nothing to check
    }
    rows.forEach((row, index) => {
      if (!row[LEMBRETE_COL.DESCRICAO]) return;
      const status = row[LEMBRETE_COL.STATUS] || "Pendente";
      if (status !== "Pendente") return;
      const vencimento = row[LEMBRETE_COL.VENCIMENTO];
      if (typeof vencimento !== "number" || vencimento > limite) return;
      const avisadoEm = row[LEMBRETE_COL.AVISADO];
      if (typeof avisadoEm === "number" && avisadoEm >= hoje) return; // already covered by today's e-mail
      const item = {
        linha: index + 2,
        descricao: String(row[LEMBRETE_COL.DESCRICAO]),
        contraparte: String(row[LEMBRETE_COL.CONTRAPARTE] || ""),
        valor: row[LEMBRETE_COL.VALOR],
        vencimento: vencimento,
      };
      (tab === CONTAS_PAGAR_TAB ? pendentes.pagar : pendentes.receber).push(item);
    });
  });

  const total = pendentes.pagar.length + pendentes.receber.length;
  if (total === 0) return { avisados: 0 };

  const destinatarios = (loadUsuarios_(deps, spreadsheetId) || []).filter(
    (u) => u.perfil === ROLE_EDITOR || u.perfil === ROLE_MASTER
  );
  const tituloAviso = total + " conta(s) para olhar — " + empresaNome;
  if (destinatarios.length > 0) {
    const corpoEmail = montarCorpoLembretes_(empresaNome, pendentes, hoje);
    const corpoPush = montarCorpoPush_(pendentes);
    destinatarios.forEach((u) => {
      enviarEmailSeguro_(deps, u.email, tituloAviso, corpoEmail);
      // Push (opt-in, per device — see completarCadastroAutorizado's sibling
      // feature registrarPush): deps.pushTokens/deps.push are only present in
      // realDeps_() once Firebase is configured, so this is a silent no-op
      // everywhere else (including every existing test's makeDeps, unchanged).
      if (deps.pushTokens && deps.push) {
        const canon = canonEmail_(u.email);
        deps.pushTokens.list().filter((t) => t.email === canon).forEach((t) => {
          const ok = deps.push.enviar(t.token, tituloAviso, corpoPush);
          if (ok === false) deps.pushTokens.remove(t.token);
        });
      }
    });
  }
  // One verified WhatsApp test contact (the Ipanema Master, 2026-10-10 — see
  // CLAUDE.md), platform-wide rather than per-company: deps.whatsapp only
  // exists in realDeps_() once the Meta test number is configured, same
  // no-op-until-configured pattern as push above.
  if (deps.whatsapp) deps.whatsapp.enviar(total, empresaNome);

  return deps.lock(() => {
    [
      { tab: CONTAS_PAGAR_TAB, itens: pendentes.pagar },
      { tab: CONTAS_RECEBER_TAB, itens: pendentes.receber },
    ].forEach((grupo) => {
      grupo.itens.forEach((item) => {
        deps.sheets.updateValues(spreadsheetId, "'" + grupo.tab + "'!J" + item.linha + ":J" + item.linha, [[hoje]]);
      });
    });
    return { avisados: total };
  });
}

function actionVerificarLembretes_(deps, access, spreadsheet, body) {
  // Only people who could actually act on the bill trigger (and receive) a
  // check — a Visualizador reading Contas a Pagar does not spend mail quota.
  if (access.perfil !== ROLE_EDITOR && access.perfil !== ROLE_MASTER) throw denied_();
  return executarVerificacaoLembretes_(deps, body.spreadsheetId, spreadsheet.empresa);
}

// ---------------------------------------------------------------------------
// Daily time-based trigger (requested 2026-10-10: the per-login check above
// means a company nobody logs into around its due dates never gets mailed —
// not good enough for a bill that matters, like a monthly accountant fee).
// Install it ONCE from the Apps Script editor: select instalarGatilhoLembretes
// and press Run. It is idempotent (removes any trigger it previously made for
// this same function before adding a new one), so running it again after a
// redeploy does not create duplicates — but it is still a manual, one-time
// step per deployment (a fresh Apps Script project, or the account migration
// described elsewhere in this file, needs it run again there).
// ---------------------------------------------------------------------------

function verificarLembretesTodasEmpresasAgendado() {
  const deps = realDeps_();
  const empresas = companyMap_(deps);
  let totalAvisado = 0;
  Object.keys(empresas).forEach((spreadsheetId) => {
    try {
      const resultado = executarVerificacaoLembretes_(deps, spreadsheetId, empresas[spreadsheetId].empresa);
      totalAvisado += resultado.avisados;
    } catch (err) {
      // One company's sheet having a problem (quota, a renamed tab, Drive
      // access pulled) must never stop the rest from being checked.
      console.error("Lembretes — falhou para " + empresas[spreadsheetId].empresa + ": " + err.message);
    }
  });
  console.log("Lembretes diários: " + totalAvisado + " conta(s) avisada(s) em " + Object.keys(empresas).length + " empresa(s).");
}

function instalarGatilhoLembretes() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "verificarLembretesTodasEmpresasAgendado") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("verificarLembretesTodasEmpresasAgendado").timeBased().everyDays(1).atHour(7).create();
  console.log("Gatilho diário instalado: verificarLembretesTodasEmpresasAgendado, por volta das 7h.");
}

// ---------------------------------------------------------------------------
// E-mail quota alert (2026-10-11, requested so the owner finds out BEFORE the
// system silently stops sending e-mail): finanponto@gmail.com's free Gmail
// account is the ONLY sender for the whole system — access-request e-mails,
// password-login codes, due-bill reminders — so every company shares the
// same daily MailApp cap. If that cap is ever reached, people silently stop
// getting codes/reminders with no visible error anywhere in the app. This
// warns ADMIN_EMAILS once the account crosses MAIL_QUOTA_ALERTA_PCT of that
// daily allowance, well before it actually runs out, so there's time to act
// (e.g. move the system account to Google Workspace for a bigger quota —
// see the scaling notes in CLAUDE.md) before anyone is actually affected.
// ---------------------------------------------------------------------------

// Google's documented free-Gmail MailApp quota (100 recipients/day as of
// this writing). MailApp itself only ever reports what's LEFT
// (getRemainingDailyQuota), never the total, so this has to be kept in sync
// by hand if finanponto@gmail.com is ever moved to a paid Workspace plan,
// which raises the real limit well above this number.
const MAIL_QUOTA_DIARIA_ESPERADA = 100;
const MAIL_QUOTA_ALERTA_PCT = 0.9;

// `restante` is injected (rather than calling MailApp directly in here) so
// the test suite can simulate any quota level without sending real mail or
// depending on the real account's actual quota at test time.
function verificarCotaDeEmail_(deps, restante) {
  const usados = MAIL_QUOTA_DIARIA_ESPERADA - restante;
  const pct = usados / MAIL_QUOTA_DIARIA_ESPERADA;
  if (pct < MAIL_QUOTA_ALERTA_PCT) return { avisado: false };

  // One alert per day: MailApp's quota resets at midnight (Pacific time, per
  // Google) — comparing against today's UTC date just needs to change once a
  // day, not match that reset instant exactly, so it's enough to stop this
  // from re-sending every time the trigger fires within the same day.
  const hoje = new Date(deps.now()).toISOString().slice(0, 10);
  if (deps.quotaEmail.getUltimoAlerta() === hoje) return { avisado: false };

  deps.mail.send({
    to: deps.config.ADMIN_EMAILS.join(","),
    subject: "Finan. — cota de e-mail quase no limite",
    body:
      "A conta de e-mail do sistema (finanponto@gmail.com) já usou " +
      usados +
      " de " +
      MAIL_QUOTA_DIARIA_ESPERADA +
      " envios de hoje (" +
      Math.round(pct * 100) +
      "%). Restam aproximadamente " +
      restante +
      ".\n\n" +
      "Essa conta envia TODOS os e-mails do sistema (pedidos de acesso, códigos de login, lembretes de contas) " +
      "para TODAS as empresas cadastradas — se a cota acabar, esses e-mails param de ser enviados silenciosamente, " +
      "sem nenhum erro visível no app.\n\n" +
      "A cota volta a zerar por volta da meia-noite no horário da Califórnia (~21h de Brasília). " +
      "Se isso estiver acontecendo com frequência, considere migrar essa conta para o Google Workspace (plano pago), " +
      "que tem um limite diário de envio bem maior.",
  });
  deps.quotaEmail.setUltimoAlerta(hoje);
  return { avisado: true };
}

function verificarCotaDeEmailAgendado() {
  verificarCotaDeEmail_(realDeps_(), MailApp.getRemainingDailyQuota());
}

function instalarGatilhoCotaDeEmail() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "verificarCotaDeEmailAgendado") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("verificarCotaDeEmailAgendado").timeBased().everyHours(2).create();
  console.log("Gatilho de cota de e-mail instalado: verificarCotaDeEmailAgendado, a cada 2 horas.");
}

// ===========================================================================
// Login with e-mail + password (alongside Google sign-in)
//
// How it stays safe with no server of our own:
//  - The browser NEVER sends the password. It derives a 256-bit key from it
//    (PBKDF2-SHA256, 210,000 rounds, salted with the e-mail) and sends only that.
//  - This script never stores that key either: it keeps HMAC-SHA256(secret
//    "pepper", random per-user salt | key). The pepper lives in the script's
//    private properties, so a copy of the Logins sheet alone cannot be attacked.
//  - Signing up needs (1) a code e-mailed to the address (proves the mailbox is
//    theirs) and (2) the system administrator's approval. Only then is the login active.
//  - Wrong passwords lock the account for 15 minutes after 5 tries; e-mails sent
//    by the public actions are rate limited; answers never reveal whether an
//    e-mail is registered.
//  - A session is a signed, expiring token (fs1.…): changing the password or
//    blocking the login kills every session at once.
// ===========================================================================

const LOGINS_TAB = "Logins";
const LOGIN_HEADERS = ["E-mail", "Nome", "Empresa", "Mensagem", "Situação", "Sal", "Verificador", "Versão", "Criado em", "Decidido em", "Código", "Código expira", "Tentativas do código", "Último acesso", "E-mail como digitado", "Login", "Função"];
const LG = { EMAIL: 0, NOME: 1, EMPRESA: 2, MSG: 3, SIT: 4, SAL: 5, VER: 6, VERSAO: 7, CRIADO: 8, DECIDIDO: 9, CODIGO: 10, CODIGO_EXP: 11, CODIGO_TENT: 12, ULTIMO: 13, DIGITADO: 14, LOGIN: 15, FUNCAO: 16 };
const SIT = { EMAIL: "Aguardando e-mail", APROVACAO: "Aguardando aprovação", ATIVO: "Ativo", RECUSADO: "Recusado", BLOQUEADO: "Bloqueado" };
const PW_PUBLIC_ACTIONS = ["pwRegister", "pwConfirmar", "pwLogin", "pwEsqueci", "pwRedefinir", "pwBuscarEmailPorLogin", "signupRequestCode", "signupConfirmar"];
const PW_SESSION_MS = 12 * 60 * 60 * 1000;
// "Manter conectado neste aparelho" (pwLogin's "lembrar" flag): a longer
// session, kept in the browser's localStorage instead of sessionStorage (see
// js/auth.js) so it survives closing the tab/app. Same kill-switch as any
// other session: changing the password or an admin blocking the login bumps
// LG.VERSAO, which invalidates every outstanding token at once, short or long.
const PW_SESSION_LONGA_MS = 30 * 24 * 60 * 60 * 1000;
const PW_CODE_MS = 15 * 60 * 1000;
const PW_CODE_MAX_TRIES = 5;
const PW_MAX_FAILS = 5;
const PW_LOCK_SECONDS = 15 * 60;
const PW_MAIL_COOLDOWN_SECONDS = 60;
const PW_MAIL_MAX_PER_WINDOW = 5;
const PW_MAIL_WINDOW_SECONDS = 6 * 60 * 60;
const PW_MAIL_GLOBAL_PER_HOUR = 60;
const PW_MAX_LOGINS = 2000;
const PW_MAX_PENDING = 200;
const PW_KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;

// ---- SHA-256 / HMAC in plain JavaScript (no Apps Script service needed, so the
// ---- same code runs in the browser tests; checked against the official test vectors).
let sha256Tabelas_ = null;

function sha256Tabelas() {
  if (sha256Tabelas_) return sha256Tabelas_;
  const primos = [];
  for (let n = 2; primos.length < 64; n += 1) {
    let ehPrimo = true;
    for (let d = 2; d * d <= n; d += 1) {
      if (n % d === 0) {
        ehPrimo = false;
        break;
      }
    }
    if (ehPrimo) primos.push(n);
  }
  const fracao32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
  sha256Tabelas_ = { K: primos.map((p) => fracao32(Math.cbrt(p))), H: primos.slice(0, 8).map((p) => fracao32(Math.sqrt(p))) };
  return sha256Tabelas_;
}

function girar_(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function utf8Bytes_(texto) {
  const binario = unescape(encodeURIComponent(String(texto)));
  const out = [];
  for (let i = 0; i < binario.length; i += 1) out.push(binario.charCodeAt(i));
  return out;
}

function sha256Bytes_(mensagem) {
  const t = sha256Tabelas();
  const h = t.H.slice();
  const tamanho = mensagem.length;
  const bytes = mensagem.slice();
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitsAlto = Math.floor((tamanho * 8) / 4294967296);
  const bitsBaixo = (tamanho * 8) >>> 0;
  for (let i = 3; i >= 0; i -= 1) bytes.push((bitsAlto >>> (i * 8)) & 0xff);
  for (let i = 3; i >= 0; i -= 1) bytes.push((bitsBaixo >>> (i * 8)) & 0xff);
  const w = new Array(64);
  for (let inicio = 0; inicio < bytes.length; inicio += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = inicio + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = girar_(w[i - 15], 7) ^ girar_(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = girar_(w[i - 2], 17) ^ girar_(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = girar_(e, 6) ^ girar_(e, 11) ^ girar_(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + t.K[i] + w[i]) >>> 0;
      const S0 = girar_(a, 2) ^ girar_(a, 13) ^ girar_(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
  }
  const saida = [];
  h.forEach((palavra) => {
    saida.push((palavra >>> 24) & 0xff, (palavra >>> 16) & 0xff, (palavra >>> 8) & 0xff, palavra & 0xff);
  });
  return saida;
}

function hexDeBytes_(bytes) {
  return bytes.map((b) => ("0" + b.toString(16)).slice(-2)).join("");
}

function hmacSha256Bytes_(chaveBytes, mensagemBytes) {
  let chave = chaveBytes.length > 64 ? sha256Bytes_(chaveBytes) : chaveBytes.slice();
  while (chave.length < 64) chave.push(0);
  const interna = chave.map((b) => b ^ 0x36).concat(mensagemBytes);
  const externa = chave.map((b) => b ^ 0x5c).concat(sha256Bytes_(interna));
  return sha256Bytes_(externa);
}

function hmacSha256Hex_(chave, mensagem) {
  return hexDeBytes_(hmacSha256Bytes_(utf8Bytes_(chave), utf8Bytes_(mensagem)));
}

// Comparison that takes the same time whatever the first difference is.
function iguaisEmTempoConstante_(a, b) {
  const x = String(a);
  const y = String(b);
  let diferenca = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diferenca |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diferenca === 0;
}

// n random bytes as hex. Apps Script's UUIDs are random v4: the fixed version and variant nibbles are skipped.
function randomHex_(nBytes) {
  let out = "";
  while (out.length < nBytes * 2) {
    const u = Utilities.getUuid().replace(/-/g, "");
    out += u.slice(0, 12) + u.slice(13, 16) + u.slice(17);
  }
  return out.slice(0, nBytes * 2);
}

// Just enough storage for verificarCotaDeEmail_'s once-a-day dedupe — a
// Script Property rather than the cache, since CacheService's max expiry
// (6h) is too short to hold "don't alert again today" across a full day.
function quotaEmailDeps_() {
  const props = PropertiesService.getScriptProperties();
  return {
    getUltimoAlerta: () => props.getProperty("MAIL_QUOTA_ALERTA_DATA"),
    setUltimoAlerta: (data) => props.setProperty("MAIL_QUOTA_ALERTA_DATA", data),
  };
}

function secretsDeps_() {
  const props = PropertiesService.getScriptProperties();
  return {
    get: () => {
      let pepper = props.getProperty("PW_PEPPER");
      let sessao = props.getProperty("PW_SESSION_KEY");
      if (!pepper || !sessao) {
        // First use: create the two secrets once. LOSING them invalidates every password and session.
        pepper = pepper || randomHex_(32);
        sessao = sessao || randomHex_(32);
        props.setProperty("PW_PEPPER", pepper);
        props.setProperty("PW_SESSION_KEY", sessao);
      }
      return { pepper: pepper, sessionKey: sessao };
    },
  };
}

// The Logins tab lives in the registry spreadsheet (created on first use).
function loginsDeps_(cache) {
  const props = PropertiesService.getScriptProperties();

  function planilha_() {
    let id = props.getProperty(REGISTRY_PROP);
    if (!id) {
      const criada = Sheets.Spreadsheets.create({ properties: { title: REGISTRY_TITLE }, sheets: [{ properties: { title: "Empresas" } }] });
      id = criada.spreadsheetId;
      Sheets.Spreadsheets.Values.update({ values: [["ID da planilha", "Empresa", "Criada em", "Criada por", "Ativa", "Segmento", "Teste expira em", "Aviso de teste enviado em"]] }, id, "Empresas!A1:H1", { valueInputOption: "RAW" });
      props.setProperty(REGISTRY_PROP, id);
    }
    const titulos = (Sheets.Spreadsheets.get(id, { fields: "sheets.properties.title" }).sheets || []).map((x) => x.properties.title);
    if (titulos.indexOf(LOGINS_TAB) === -1) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: LOGINS_TAB } } }] }, id);
      Sheets.Spreadsheets.Values.update({ values: [LOGIN_HEADERS] }, id, LOGINS_TAB + "!A1:Q1", { valueInputOption: "RAW" });
    }
    return id;
  }

  function normalizar_(linha) {
    const c = [];
    for (let i = 0; i < LOGIN_HEADERS.length; i += 1) c.push(linha[i] === undefined || linha[i] === null ? "" : linha[i]);
    return c;
  }

  return {
    list: () => {
      const guardado = cache.get("lgs_list");
      if (guardado) return JSON.parse(guardado);
      if (!props.getProperty(REGISTRY_PROP)) return [];
      const dados = Sheets.Spreadsheets.Values.get(planilha_(), LOGINS_TAB + "!A2:Q", { valueRenderOption: "UNFORMATTED_VALUE" });
      const lista = (dados.values || []).map((linha, i) => ({ linha: i + 2, c: normalizar_(linha) })).filter((l) => l.c[LG.EMAIL] !== "");
      cache.put("lgs_list", JSON.stringify(lista), 20);
      return lista;
    },
    add: (c) => {
      const id = planilha_();
      const existentes = Sheets.Spreadsheets.Values.get(id, LOGINS_TAB + "!A2:A");
      const proxima = (existentes.values || []).length + 2;
      Sheets.Spreadsheets.Values.update({ values: [normalizar_(c)] }, id, LOGINS_TAB + "!A" + proxima + ":Q" + proxima, { valueInputOption: "RAW" });
      cache.remove("lgs_list");
    },
    update: (linha, c) => {
      Sheets.Spreadsheets.Values.update({ values: [normalizar_(c)] }, planilha_(), LOGINS_TAB + "!A" + linha + ":Q" + linha, { valueInputOption: "RAW" });
      cache.remove("lgs_list");
    },
  };
}

// ---- helpers ---------------------------------------------------------------

function chaveDeSenhaValida_(chave) {
  return typeof chave === "string" && PW_KEY_FORMAT.test(chave);
}

function emailValido_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

// "Login" (apelido escolhido pela pessoa): a separate, chosen identifier people
// can sign in with instead of typing their e-mail every time (see
// acaoPwBuscarEmailPorLogin_). It never replaces the e-mail, only stands in
// for it when someone types it on the sign-in screen.
function limparLogin_(valor) {
  if (typeof valor !== "string") return "";
  return (valor.normalize ? valor.normalize("NFKC") : valor).trim();
}

function loginValido_(login) {
  return /^[A-Za-z0-9._-]{3,30}$/.test(login);
}

// true if some OTHER row already uses this login (case-insensitive). Pass the
// row being edited's own line number so it does not collide with itself.
function loginEmUso_(deps, login, linhaIgnorar) {
  const chave = login.toLowerCase();
  return deps.logins.list().some((l) => l.linha !== linhaIgnorar && String(l.c[LG.LOGIN] || "").toLowerCase() === chave);
}

function acharLogin_(deps, canon) {
  return deps.logins.list().filter((l) => l.c[LG.EMAIL] === canon)[0] || null;
}

function enviarEmailSeguro_(deps, para, assunto, corpo) {
  try {
    deps.mail.send({ to: para, subject: assunto, body: corpo });
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// At most one e-mail a minute and 5 per 6 hours to one address, 60 an hour overall:
// the public actions send e-mails on request, so they must not be a way to spam anyone.
function limitarEmails_(deps, canon) {
  const cooldown = "pwmail_" + canon;
  if (deps.cache.get(cooldown)) throw new GatewayError_(429, "Aguarde um minuto antes de pedir outro e-mail.");
  const chaveN = "pwmailn_" + canon;
  const n = Number(deps.cache.get(chaveN) || 0);
  if (n >= PW_MAIL_MAX_PER_WINDOW) throw new GatewayError_(429, "Já enviamos vários e-mails para este endereço. Tente de novo mais tarde.");
  const chaveG = "pwmailg_" + Math.floor(deps.now() / 3600000);
  const g = Number(deps.cache.get(chaveG) || 0);
  if (g >= PW_MAIL_GLOBAL_PER_HOUR) throw new GatewayError_(429, "O serviço está muito ocupado agora. Tente de novo em alguns minutos.");
  deps.cache.put(cooldown, "1", PW_MAIL_COOLDOWN_SECONDS);
  deps.cache.put(chaveN, String(n + 1), PW_MAIL_WINDOW_SECONDS);
  deps.cache.put(chaveG, String(g + 1), 3700);
}

function gerarCodigo_(deps) {
  const n = parseInt(deps.randomHex(8).slice(0, 10), 16) % 1000000;
  return ("00000" + n).slice(-6);
}

function hashDoCodigo_(secrets, canon, codigo) {
  return hmacSha256Hex_(secrets.pepper, "code|" + canon + "|" + codigo);
}

function codigoDeSeisDigitos_(valor) {
  const digitos = String(valor === undefined || valor === null ? "" : valor).replace(/\D/g, "");
  if (digitos.length !== 6) throw new GatewayError_(400, "Digite os 6 números do código que enviamos por e-mail.");
  return digitos;
}

// Checks the e-mailed code of a login row. A wrong code counts; 5 wrong ones cancel it.
function conferirCodigo_(deps, login, canon, codigo, secrets) {
  const c = login.c;
  const falha = () => new GatewayError_(400, "Código incorreto ou expirado. Peça um novo.");
  if (!c[LG.CODIGO] || Number(c[LG.CODIGO_EXP]) < deps.now() || Number(c[LG.CODIGO_TENT]) >= PW_CODE_MAX_TRIES) throw falha();
  if (iguaisEmTempoConstante_(hashDoCodigo_(secrets, canon, codigo), c[LG.CODIGO])) return;
  const novas = Number(c[LG.CODIGO_TENT]) + 1;
  const copia = c.slice();
  copia[LG.CODIGO_TENT] = novas;
  if (novas >= PW_CODE_MAX_TRIES) copia[LG.CODIGO] = "";
  deps.logins.update(login.linha, copia);
  throw falha();
}

function definirSenha_(secrets, deps, c, chave) {
  const sal = deps.randomHex(16);
  c[LG.SAL] = sal;
  c[LG.VER] = hmacSha256Hex_(secrets.pepper, sal + "|" + chave);
  c[LG.VERSAO] = Number(c[LG.VERSAO] || 0) + 1;
  c[LG.CODIGO] = "";
  c[LG.CODIGO_EXP] = "";
  c[LG.CODIGO_TENT] = 0;
}

function emailsDoSistema_(deps) {
  return deps.config.ADMIN_EMAILS.join(",");
}

// ---- sessions ----------------------------------------------------------------

function emitirSessao_(deps, login, duracaoMs) {
  const secrets = deps.secrets.get();
  const expira = deps.now() + (duracaoMs || PW_SESSION_MS);
  const emailHex = hexDeBytes_(utf8Bytes_(limparEmail_(login.c[LG.DIGITADO])));
  const versao = Number(login.c[LG.VERSAO]);
  const assinatura = hmacSha256Hex_(secrets.sessionKey, "s|" + emailHex + "|" + expira + "|" + versao);
  return { token: "fs1." + emailHex + "." + expira + "." + versao + "." + assinatura, expiraEm: expira };
}

function verificarSessaoSenha_(deps, token) {
  const expirada = () => new GatewayError_(401, "Sessão expirada. Entre novamente.");
  if (typeof token !== "string" || token.length > 600) throw expirada();
  const partes = token.split(".");
  if (partes.length !== 5 || partes[0] !== "fs1" || !/^[0-9a-f]{2,400}$/.test(partes[1]) || !/^\d{10,16}$/.test(partes[2]) || !/^\d{1,9}$/.test(partes[3])) throw expirada();
  const secrets = deps.secrets.get();
  const esperada = hmacSha256Hex_(secrets.sessionKey, "s|" + partes[1] + "|" + partes[2] + "|" + partes[3]);
  if (!iguaisEmTempoConstante_(esperada, partes[4])) throw expirada();
  if (Number(partes[2]) < deps.now()) throw expirada();
  let email = "";
  try {
    const bytes = partes[1].match(/../g).map((h) => parseInt(h, 16));
    email = decodeURIComponent(bytes.map((b) => "%" + ("0" + b.toString(16)).slice(-2)).join(""));
  } catch (err) {
    throw expirada();
  }
  const login = acharLogin_(deps, canonEmail_(email));
  if (!login || login.c[LG.SIT] !== SIT.ATIVO || Number(login.c[LG.VERSAO]) !== Number(partes[3])) throw expirada();
  return limparEmail_(login.c[LG.DIGITADO]);
}

// ---- public actions (no token) -----------------------------------------------

function despacharPublico_(body, deps) {
  try {
    switch (body.action) {
      case "pwRegister": return acaoPwRegister_(deps, body);
      case "pwConfirmar": return acaoPwConfirmar_(deps, body);
      case "pwLogin": return acaoPwLogin_(deps, body);
      case "pwEsqueci": return acaoPwEsqueci_(deps, body);
      case "pwBuscarEmailPorLogin": return acaoPwBuscarEmailPorLogin_(deps, body);
      case "signupRequestCode": return acaoSignupRequestCode_(deps, body);
      case "signupConfirmar": return acaoSignupConfirmar_(deps, body);
      default: return acaoPwRedefinir_(deps, body);
    }
  } catch (err) {
    if (err instanceof GatewayError_) throw err;
    console.error(err);
    // Nothing internal is put in an answer to someone who has not proved who they are.
    throw new GatewayError_(500, "Erro interno no servidor do app.");
  }
}

function acaoPwRegister_(deps, body) {
  const email = limparEmail_(body.email);
  const canon = canonEmail_(email);
  if (!emailValido_(email)) throw new GatewayError_(400, "Informe um e-mail válido.");
  const nome = cleanText_(body.nome, 80, false);
  if (!nome) throw new GatewayError_(400, "Informe o seu nome.");
  const login = limparLogin_(body.login);
  if (!loginValido_(login)) throw new GatewayError_(400, "Escolha um login com 3 a 30 letras, números, ponto, hífen ou underline.");
  const funcao = cleanText_(body.funcao, 60, false);
  if (!funcao) throw new GatewayError_(400, "Informe a sua função na empresa.");
  const empresa = cleanText_(body.empresa, 80, false);
  const mensagem = cleanText_(body.mensagem, 500, true);
  if (!chaveDeSenhaValida_(body.chave)) throw new GatewayError_(400, "Senha inválida.");

  return deps.lock(() => {
    limitarEmails_(deps, canon);
    const secrets = deps.secrets.get();
    const atual = acharLogin_(deps, canon);
    if (atual && atual.c[LG.SIT] !== SIT.EMAIL) {
      // The answer is the same as for a new sign-up: nobody can probe which addresses exist.
      enviarEmailSeguro_(deps, email, "Finan.: você já tem cadastro", "Olá!\n\nRecebemos um pedido de cadastro com este e-mail, mas ele já existe.\n\nSe foi você, use \"Esqueci minha senha\" na tela de entrada para criar uma nova senha. Se não foi você, pode ignorar esta mensagem.\n");
      return { enviado: true };
    }
    if (loginEmUso_(deps, login, atual ? atual.linha : null)) throw new GatewayError_(400, "Esse login já está em uso. Escolha outro.");
    if (!atual) {
      const lista = deps.logins.list();
      if (lista.length >= PW_MAX_LOGINS) throw new GatewayError_(503, "Limite de cadastros atingido.");
      if (lista.filter((l) => l.c[LG.SIT] === SIT.EMAIL || l.c[LG.SIT] === SIT.APROVACAO).length >= PW_MAX_PENDING) throw new GatewayError_(503, "Muitos cadastros em análise. Tente mais tarde.");
    }
    const codigo = gerarCodigo_(deps);
    const c = atual ? atual.c.slice() : LOGIN_HEADERS.map(() => "");
    c[LG.EMAIL] = canon;
    c[LG.NOME] = nome;
    c[LG.EMPRESA] = empresa;
    c[LG.MSG] = mensagem;
    c[LG.SIT] = SIT.EMAIL;
    c[LG.CRIADO] = new Date(deps.now()).toISOString();
    c[LG.DIGITADO] = email;
    c[LG.LOGIN] = login;
    c[LG.FUNCAO] = funcao;
    definirSenha_(secrets, deps, c, body.chave);
    c[LG.CODIGO] = hashDoCodigo_(secrets, canon, codigo);
    c[LG.CODIGO_EXP] = deps.now() + PW_CODE_MS;
    c[LG.CODIGO_TENT] = 0;
    if (atual) deps.logins.update(atual.linha, c);
    else deps.logins.add(c);
    const enviado = enviarEmailSeguro_(deps, email, "Finan.: seu código de confirmação", "Olá, " + nome + "!\n\nSeu código de confirmação é: " + codigo + "\n\nEle vale por 15 minutos. Digite-o no Finan. para confirmar este e-mail.\n\nSe você não pediu este cadastro, ignore esta mensagem.\n");
    if (!enviado) throw new GatewayError_(503, "Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos.");
    return { enviado: true };
  });
}

function acaoPwConfirmar_(deps, body) {
  const canon = canonEmail_(limparEmail_(body.email));
  const codigo = codigoDeSeisDigitos_(body.codigo);
  return deps.lock(() => {
    const secrets = deps.secrets.get();
    const login = acharLogin_(deps, canon);
    if (!login || login.c[LG.SIT] !== SIT.EMAIL) throw new GatewayError_(400, "Código incorreto ou expirado. Peça um novo.");
    conferirCodigo_(deps, login, canon, codigo, secrets);
    const c = login.c.slice();
    c[LG.CODIGO] = "";
    c[LG.CODIGO_EXP] = "";
    c[LG.CODIGO_TENT] = 0;
    // A Master already authorized this e-mail (it is in some company's
    // Usuários): the e-mail code just confirmed above is this flow's own
    // proof of ownership, so there is nothing left for the system
    // administrator to approve — skip straight to Ativo.
    if (autorizadoEmAlgumaEmpresa_(deps, canon)) {
      c[LG.SIT] = SIT.ATIVO;
      c[LG.DECIDIDO] = new Date(deps.now()).toISOString();
      deps.logins.update(login.linha, c);
      enviarEmailSeguro_(
        deps,
        limparEmail_(c[LG.DIGITADO]),
        "Finan.: seu login e senha já estão liberados",
        "Olá, " + c[LG.NOME] + ".\n\nComo este e-mail já era autorizado por uma empresa no Finan., seu login e senha já estão liberados — não é preciso esperar o administrador do sistema. Entre em " + deps.config.APP_URL + " com e-mail (ou login: " + c[LG.LOGIN] + ") e a senha que você criou.\n"
      );
      return { situacao: SIT.ATIVO };
    }
    c[LG.SIT] = SIT.APROVACAO;
    deps.logins.update(login.linha, c);
    enviarEmailSeguro_(
      deps,
      emailsDoSistema_(deps),
      "Finan.: novo login com senha para aprovar — " + c[LG.NOME],
      "Um novo login com e-mail e senha foi criado e o e-mail já foi confirmado.\n\nNome: " + c[LG.NOME] + "\nLogin: " + c[LG.LOGIN] + "\nFunção: " + (c[LG.FUNCAO] || "(não informada)") + "\nE-mail: " + c[LG.DIGITADO] + "\nEmpresa: " + (c[LG.EMPRESA] || "(não informada)") + "\nMensagem: " + (c[LG.MSG] || "(sem mensagem)") + "\n\nPara liberar (ou recusar), entre em " + deps.config.APP_URL + " e abra o Painel do sistema > Logins com senha.\n"
    );
    return { situacao: SIT.APROVACAO };
  });
}

function acaoPwLogin_(deps, body) {
  const generico = () => new GatewayError_(403, "E-mail ou senha incorretos.");
  const canon = canonEmail_(limparEmail_(body.email));
  if (!chaveDeSenhaValida_(body.chave) || !canon) throw generico();
  const chaveFalhas = "pwfail_" + canon;
  const falhas = Number(deps.cache.get(chaveFalhas) || 0);
  if (falhas >= PW_MAX_FAILS) throw new GatewayError_(429, "Muitas tentativas. Aguarde 15 minutos e tente de novo.");
  const secrets = deps.secrets.get();
  const login = acharLogin_(deps, canon);
  // The same work is done whether or not the address exists (no timing hint).
  const calculado = hmacSha256Hex_(secrets.pepper, (login ? login.c[LG.SAL] : "0000000000000000") + "|" + body.chave);
  const certo = login && iguaisEmTempoConstante_(calculado, login.c[LG.VER]);
  if (!certo) {
    deps.cache.put(chaveFalhas, String(falhas + 1), PW_LOCK_SECONDS);
    throw generico();
  }
  deps.cache.remove(chaveFalhas);
  const situacao = login.c[LG.SIT];
  if (situacao === SIT.EMAIL) throw new GatewayError_(403, "Falta confirmar o seu e-mail. Use \"Criar acesso\" de novo para receber outro código.");
  if (situacao === SIT.APROVACAO) throw new GatewayError_(403, "Seu cadastro está aguardando a aprovação do administrador. Você receberá um e-mail quando for liberado.");
  if (situacao !== SIT.ATIVO) throw new GatewayError_(403, "Este acesso não está liberado. Fale com o administrador.");
  const sessao = emitirSessao_(deps, login, body.lembrar === true ? PW_SESSION_LONGA_MS : PW_SESSION_MS);
  deps.lock(() => {
    const atual = acharLogin_(deps, canon);
    if (!atual) return;
    const c = atual.c.slice();
    c[LG.ULTIMO] = new Date(deps.now()).toISOString();
    deps.logins.update(atual.linha, c);
  });
  return { token: sessao.token, expiraEm: sessao.expiraEm, email: limparEmail_(login.c[LG.DIGITADO]), nome: String(login.c[LG.NOME] || "") };
}

// Resolves a chosen "login" (username) to the real e-mail, so the browser can
// derive the PBKDF2 key with the right salt (the key derivation needs the
// e-mail — see js/senha.js — and the person typed a username instead). Same
// generic failure + lockout as pwLogin itself: this must not reveal whether a
// login exists any more precisely than "e-mail ou senha incorretos" already does.
function acaoPwBuscarEmailPorLogin_(deps, body) {
  const generico = () => new GatewayError_(403, "E-mail ou senha incorretos.");
  const login = limparLogin_(body.login);
  if (!login) throw generico();
  const chaveFalhas = "pwlookup_" + login.toLowerCase();
  const falhas = Number(deps.cache.get(chaveFalhas) || 0);
  if (falhas >= PW_MAX_FAILS) throw new GatewayError_(429, "Muitas tentativas. Aguarde 15 minutos e tente de novo.");
  const encontrado = deps.logins.list().filter(
    (l) => l.c[LG.SIT] === SIT.ATIVO && String(l.c[LG.LOGIN] || "").toLowerCase() === login.toLowerCase()
  )[0];
  if (!encontrado) {
    deps.cache.put(chaveFalhas, String(falhas + 1), PW_LOCK_SECONDS);
    throw generico();
  }
  deps.cache.remove(chaveFalhas);
  return { email: limparEmail_(encontrado.c[LG.DIGITADO]) };
}

// ---------------------------------------------------------------------------
// Self-service company signup (2026-10-28, "SaaS Fase 2" — see CLAUDE.md).
// Two-step public flow, same shape as pwRegister/pwConfirmar: a stranger
// claims an e-mail, gets a 6-digit code, confirms it — and ONLY on
// confirmation does the company actually get created, exactly mirroring the
// password-login flow's "the code is the proof of ownership" reasoning. No
// token/role check applies (anyone with a working e-mail may try this), so
// everything here is about abuse resistance instead: reCAPTCHA (when
// configured — see verificarCaptcha_ below), the same per-address cooldown/
// window/global cap limitarEmails_ already enforces for every other public
// mail-sending action, and a re-check of MAX_COMPANIES/duplicate-name right
// before actually creating (time passes between the two steps).
//
// Every signup starts a 14-day trial (SIGNUP_TRIAL_DIAS) — see
// executarVerificacaoTrials_ below for how that gets enforced and reminded
// about. A company created through the ADMIN-ONLY actionCreateCompany_
// (Painel do sistema) never gets a trial clock at all — that path is for the
// system administrator onboarding someone directly, not a stranger
// self-signing-up, so it keeps behaving exactly as it always has.
// ---------------------------------------------------------------------------

const SIGNUP_CODE_MS = 15 * 60 * 1000;
const SIGNUP_MAX_TENTATIVAS = 5;
const SIGNUP_TRIAL_DIAS = 14;
const SIGNUP_AVISO_DIAS_ANTES = 3;

// Verifies a reCAPTCHA token against Google's siteverify endpoint. A SILENT
// PASS-THROUGH (returns true without checking anything) when
// RECAPTCHA_SECRET_KEY is not set in Script Properties — same config-gated,
// no-op-until-configured pattern as Firebase push/WhatsApp elsewhere in this
// file, so pasting this code changes nothing until the key is actually set.
// ⚠️ Not safe to publicize self-service signup anywhere until it IS set —
// without it, this endpoint has no bot protection at all beyond the e-mail
// cooldown. See CLAUDE.md.
function verificarCaptcha_(deps, token) {
  if (!deps.recaptcha) return true;
  return deps.recaptcha.verificar(token);
}

function recaptchaSecreta_() {
  return PropertiesService.getScriptProperties().getProperty("RECAPTCHA_SECRET_KEY") || "";
}

function verificarCaptchaReal_(token, secreta) {
  if (!token || typeof token !== "string") return false;
  try {
    const resposta = UrlFetchApp.fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "post",
      payload: { secret: secreta, response: token },
      muteHttpExceptions: true,
    });
    const dados = JSON.parse(resposta.getContentText());
    return dados.success === true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function acaoSignupRequestCode_(deps, body) {
  const email = limparEmail_(body.email);
  const canon = canonEmail_(email);
  if (!emailValido_(email)) throw new GatewayError_(400, "Informe um e-mail válido.");
  const nomeEmpresa = cleanText_(body.nomeEmpresa, 80, false);
  if (!nomeEmpresa) throw new GatewayError_(400, "Informe o nome da empresa.");
  const nomeResponsavel = cleanText_(body.nomeResponsavel, 80, false);
  if (!nomeResponsavel) throw new GatewayError_(400, "Informe o seu nome.");
  if (body.segmento !== undefined && (typeof body.segmento !== "string" || !Object.prototype.hasOwnProperty.call(SEGMENTOS, body.segmento))) {
    throw new GatewayError_(400, "Segmento inválido.");
  }
  const segmento = segmentoValido_(body.segmento);
  if (!verificarCaptcha_(deps, body.captchaToken)) {
    throw new GatewayError_(400, "Não foi possível confirmar que você não é um robô. Tente novamente.");
  }

  return deps.lock(() => {
    limitarEmails_(deps, canon); // same per-address cooldown/window/global cap as every other public mail-sending action
    const known = companyMap_(deps);
    const ids = Object.keys(known);
    if (ids.length >= MAX_COMPANIES) throw new GatewayError_(400, "No momento não estamos aceitando novos cadastros. Fale com a gente.");
    if (ids.some((id) => String(known[id].empresa).trim().toLowerCase() === nomeEmpresa.toLowerCase())) {
      throw new GatewayError_(400, "Já existe uma empresa com esse nome.");
    }

    const secrets = deps.secrets.get();
    const codigo = gerarCodigo_(deps);
    const pendente = {
      email: email,
      nomeEmpresa: nomeEmpresa,
      nomeResponsavel: nomeResponsavel,
      segmento: segmento,
      codigoHash: hashDoCodigo_(secrets, canon, codigo),
      expira: deps.now() + SIGNUP_CODE_MS,
      tentativas: 0,
    };
    deps.cache.put("signup_" + canon, JSON.stringify(pendente), Math.ceil(SIGNUP_CODE_MS / 1000));
    const enviado = enviarEmailSeguro_(
      deps,
      email,
      "Finan.: seu código de confirmação",
      "Olá, " + nomeResponsavel + "!\n\nSeu código de confirmação para criar a empresa \"" + nomeEmpresa + "\" no Finan. é: " + codigo + "\n\nEle vale por 15 minutos.\n\nSe você não pediu este cadastro, ignore esta mensagem.\n"
    );
    if (!enviado) throw new GatewayError_(503, "Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos.");
    return { enviado: true };
  });
}

function acaoSignupConfirmar_(deps, body) {
  const canon = canonEmail_(limparEmail_(body.email));
  const codigo = codigoDeSeisDigitos_(body.codigo);
  const falha = () => new GatewayError_(400, "Código incorreto ou expirado. Peça um novo.");

  return deps.lock(() => {
    const guardado = deps.cache.get("signup_" + canon);
    if (!guardado) throw falha();
    const pendente = JSON.parse(guardado);
    if (deps.now() > pendente.expira || pendente.tentativas >= SIGNUP_MAX_TENTATIVAS) {
      deps.cache.remove("signup_" + canon);
      throw falha();
    }
    const secrets = deps.secrets.get();
    if (!iguaisEmTempoConstante_(hashDoCodigo_(secrets, canon, codigo), pendente.codigoHash)) {
      pendente.tentativas += 1;
      const restanteMs = Math.max(1000, pendente.expira - deps.now());
      deps.cache.put("signup_" + canon, JSON.stringify(pendente), Math.ceil(restanteMs / 1000));
      throw falha();
    }
    deps.cache.remove("signup_" + canon);

    // Re-check right before creating: time has passed since the request step.
    const known = companyMap_(deps);
    const ids = Object.keys(known);
    if (ids.length >= MAX_COMPANIES) throw new GatewayError_(400, "No momento não estamos aceitando novos cadastros. Fale com a gente.");
    if (ids.some((id) => String(known[id].empresa).trim().toLowerCase() === pendente.nomeEmpresa.toLowerCase())) {
      throw new GatewayError_(400, "Já existe uma empresa com esse nome.");
    }

    const spreadsheetId = deps.sheets.createCompanySpreadsheet(pendente.nomeEmpresa + " — Finan.", pendente.nomeEmpresa, pendente.segmento);
    deps.sheets.updateValues(spreadsheetId, USUARIOS_TAB + "!A2:C2", [[pendente.email, pendente.nomeResponsavel, ROLE_MASTER]]);
    const testeExpiraEm = hojeSerial_(deps) + SIGNUP_TRIAL_DIAS;
    deps.registry.add({ spreadsheetId: spreadsheetId, empresa: pendente.nomeEmpresa, criadaPor: pendente.email, segmento: pendente.segmento, testeExpiraEm: testeExpiraEm });
    deps.cache.remove("usr_" + spreadsheetId);
    reindexarEmpresaUsuarios_(deps, spreadsheetId);
    enviarEmailSeguro_(
      deps,
      pendente.email,
      "Finan.: sua empresa foi criada!",
      "Olá, " + pendente.nomeResponsavel + "!\n\nA empresa \"" + pendente.nomeEmpresa + "\" foi criada no Finan. Você tem 14 dias grátis para testar — entre em " + deps.config.APP_URL + " com este mesmo e-mail (" + pendente.email + ") para começar.\n"
    );
    return { spreadsheetId: spreadsheetId, empresa: pendente.nomeEmpresa, segmento: pendente.segmento, testeExpiraEm: testeExpiraEm };
  });
}

// ---------------------------------------------------------------------------
// Trial expiry — the other half of making self-service signup safe: without
// this, "14 dias grátis" would just be an unlimited free company forever.
// Checked once a day (instalarGatilhoTrials below), same pattern as every
// other daily job in this file (lembretes, cota de e-mail, índice de
// e-mails). Sends exactly two reminders per trial (at 3 days left and on the
// last day — the exact two points the user asked for, not a reminder every
// day of the last 3) plus one "encerrado" notice the day it actually
// deactivates; dedup via the registry's own "Aviso de teste enviado em"
// column, same reasoning as the Contas a Pagar/Receber reminder's "Avisado
// em" (a cache key would not survive a whole day; CacheService's own max TTL
// is 6h).
// ---------------------------------------------------------------------------

function avisarDonoTrial_(deps, empresaRegistro, tipo, diasRestantes) {
  let masters;
  try {
    masters = (loadUsuarios_(deps, empresaRegistro.spreadsheetId) || []).filter((u) => u.perfil === ROLE_MASTER);
  } catch (err) {
    masters = [];
  }
  if (!masters.length) return;
  const assunto =
    tipo === "ultimoDia"
      ? "Finan.: seu teste grátis termina hoje — " + empresaRegistro.empresa
      : tipo === "tresDias"
      ? "Finan.: faltam " + diasRestantes + " dias do seu teste grátis — " + empresaRegistro.empresa
      : "Finan.: seu teste grátis terminou — " + empresaRegistro.empresa;
  const corpo =
    tipo === "encerrado"
      ? "Olá!\n\nO período de teste grátis da empresa \"" + empresaRegistro.empresa + "\" terminou e o acesso foi temporariamente desativado. Os dados continuam guardados — fale com a gente para continuar usando o Finan.\n"
      : "Olá!\n\nFaltam " + diasRestantes + " dia(s) para o fim do teste grátis da empresa \"" + empresaRegistro.empresa + "\". Fale com a gente para continuar usando o Finan. sem interrupção.\n";
  masters.forEach((m) => enviarEmailSeguro_(deps, m.email, assunto, corpo));
}

function executarVerificacaoTrials_(deps) {
  const hoje = hojeSerial_(deps);
  const empresas = deps.registry && deps.registry.listAll ? deps.registry.listAll() : [];
  let desativadas = 0;
  let avisadas = 0;
  empresas.forEach((e) => {
    if (e.ativa === false) return; // already deactivated — nothing to do
    if (!e.testeExpiraEm) return; // not a trial (admin-created, or never on one)
    if (hoje > e.testeExpiraEm) {
      deps.registry.setActive(e.spreadsheetId, false);
      desativadas += 1;
      avisarDonoTrial_(deps, e, "encerrado");
      return;
    }
    const diasRestantes = e.testeExpiraEm - hoje;
    if (diasRestantes === SIGNUP_AVISO_DIAS_ANTES || diasRestantes === 0) {
      if (e.avisoTesteEm === hoje) return; // already warned today (trigger ran twice, safety)
      avisarDonoTrial_(deps, e, diasRestantes === 0 ? "ultimoDia" : "tresDias", diasRestantes);
      if (deps.registry.marcarAvisoTeste) deps.registry.marcarAvisoTeste(e.spreadsheetId, hoje);
      avisadas += 1;
    }
  });
  return { desativadas: desativadas, avisadas: avisadas };
}

function verificarTrialsTodasEmpresasAgendado() {
  const deps = realDeps_();
  const resultado = executarVerificacaoTrials_(deps);
  console.log("Trials: " + resultado.desativadas + " desativada(s), " + resultado.avisadas + " avisada(s).");
}

function instalarGatilhoTrials() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "verificarTrialsTodasEmpresasAgendado") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("verificarTrialsTodasEmpresasAgendado").timeBased().everyDays(1).atHour(8).create();
  console.log("Gatilho diário instalado: verificarTrialsTodasEmpresasAgendado, por volta das 8h.");
}

function acaoPwEsqueci_(deps, body) {
  const email = limparEmail_(body.email);
  const canon = canonEmail_(email);
  if (!emailValido_(email)) throw new GatewayError_(400, "Informe um e-mail válido.");
  return deps.lock(() => {
    limitarEmails_(deps, canon);
    const secrets = deps.secrets.get();
    const login = acharLogin_(deps, canon);
    if (login && login.c[LG.SIT] === SIT.ATIVO) {
      const codigo = gerarCodigo_(deps);
      const c = login.c.slice();
      c[LG.CODIGO] = hashDoCodigo_(secrets, canon, codigo);
      c[LG.CODIGO_EXP] = deps.now() + PW_CODE_MS;
      c[LG.CODIGO_TENT] = 0;
      deps.logins.update(login.linha, c);
      enviarEmailSeguro_(deps, email, "Finan.: código para criar uma nova senha", "Olá!\n\nSeu código para criar uma nova senha é: " + codigo + "\n\nEle vale por 15 minutos. Se você não pediu, ignore esta mensagem: sua senha atual continua valendo.\n");
    }
    // Same answer whether or not the address has a login.
    return { enviado: true };
  });
}

function acaoPwRedefinir_(deps, body) {
  const canon = canonEmail_(limparEmail_(body.email));
  const codigo = codigoDeSeisDigitos_(body.codigo);
  if (!chaveDeSenhaValida_(body.chave)) throw new GatewayError_(400, "Senha inválida.");
  return deps.lock(() => {
    const secrets = deps.secrets.get();
    const login = acharLogin_(deps, canon);
    if (!login || login.c[LG.SIT] !== SIT.ATIVO) throw new GatewayError_(400, "Código incorreto ou expirado. Peça um novo.");
    conferirCodigo_(deps, login, canon, codigo, secrets);
    const c = login.c.slice();
    definirSenha_(secrets, deps, c, body.chave);
    deps.logins.update(login.linha, c);
    deps.cache.remove("pwfail_" + canon);
    enviarEmailSeguro_(deps, limparEmail_(c[LG.DIGITADO]), "Finan.: sua senha foi alterada", "Olá, " + c[LG.NOME] + ".\n\nA senha do seu acesso ao Finan. acabou de ser alterada. Se não foi você, peça imediatamente ao administrador para bloquear o seu acesso.\n");
    return { redefinida: true };
  });
}

// ---- actions for a signed-in person / the administrator ----------------------

function acaoPwTrocarSenha_(deps, email, sessaoSenha, body) {
  if (!sessaoSenha) throw new GatewayError_(403, "Só quem entrou com e-mail e senha pode trocar a senha por aqui.");
  if (!chaveDeSenhaValida_(body.atual) || !chaveDeSenhaValida_(body.nova)) throw new GatewayError_(400, "Senha inválida.");
  const canon = canonEmail_(email);
  const chaveFalhas = "pwfail_" + canon;
  const falhas = Number(deps.cache.get(chaveFalhas) || 0);
  if (falhas >= PW_MAX_FAILS) throw new GatewayError_(429, "Muitas tentativas. Aguarde 15 minutos e tente de novo.");
  return deps.lock(() => {
    const secrets = deps.secrets.get();
    const login = acharLogin_(deps, canon);
    if (!login || login.c[LG.SIT] !== SIT.ATIVO) throw new GatewayError_(401, "Sessão expirada. Entre novamente.");
    const calculado = hmacSha256Hex_(secrets.pepper, login.c[LG.SAL] + "|" + body.atual);
    if (!iguaisEmTempoConstante_(calculado, login.c[LG.VER])) {
      deps.cache.put(chaveFalhas, String(falhas + 1), PW_LOCK_SECONDS);
      throw new GatewayError_(403, "A senha atual está incorreta.");
    }
    deps.cache.remove(chaveFalhas);
    const c = login.c.slice();
    definirSenha_(secrets, deps, c, body.nova);
    deps.logins.update(login.linha, c);
    enviarEmailSeguro_(deps, limparEmail_(c[LG.DIGITADO]), "Finan.: sua senha foi alterada", "Olá, " + c[LG.NOME] + ".\n\nA senha do seu acesso ao Finan. acabou de ser alterada. Se não foi você, peça imediatamente ao administrador para bloquear o seu acesso.\n");
    const sessao = emitirSessao_(deps, { c: c }, body.lembrar === true ? PW_SESSION_LONGA_MS : PW_SESSION_MS);
    return { token: sessao.token, expiraEm: sessao.expiraEm };
  });
}

// Offered right after a Google sign-in to someone a company Master already
// authorized (is in that company's Usuários) but who has no e-mail+senha
// login yet — so they stop having to redo the Google flow every ~hour (see
// CLAUDE.md "Manter conectado..."). Google itself already proved the e-mail,
// and the Master's own act of listing it already is the approval, so this
// activates immediately: no e-mail code, no system-administrator review.
// Deliberately Google-session only (never a password session calling this on
// itself) and deliberately re-checks authorization server-side even though
// the client only shows this screen after already confirming it with "me" —
// never trust the client's reason for calling an action.
function actionCompletarCadastro_(deps, email, sessaoSenha, body) {
  if (sessaoSenha) throw new GatewayError_(400, "Você já entra com e-mail e senha.");
  const canon = canonEmail_(email);
  if (!autorizadoEmAlgumaEmpresa_(deps, canon)) throw denied_();

  const nome = cleanText_(body.nome, 80, false);
  if (!nome) throw new GatewayError_(400, "Informe o seu nome.");
  const login = limparLogin_(body.login);
  if (!loginValido_(login)) throw new GatewayError_(400, "Escolha um login com 3 a 30 letras, números, ponto, hífen ou underline.");
  const funcao = cleanText_(body.funcao, 60, false);
  if (!funcao) throw new GatewayError_(400, "Informe a sua função na empresa.");
  if (!chaveDeSenhaValida_(body.chave)) throw new GatewayError_(400, "Senha inválida.");

  return deps.lock(() => {
    const secrets = deps.secrets.get();
    const existente = acharLogin_(deps, canon);
    if (existente && existente.c[LG.SIT] === SIT.ATIVO) throw new GatewayError_(400, "Você já tem um login e senha ativos.");
    if (loginEmUso_(deps, login, existente ? existente.linha : null)) throw new GatewayError_(400, "Esse login já está em uso. Escolha outro.");
    const c = existente ? existente.c.slice() : LOGIN_HEADERS.map(() => "");
    c[LG.EMAIL] = canon;
    c[LG.NOME] = nome;
    c[LG.LOGIN] = login;
    c[LG.FUNCAO] = funcao;
    c[LG.SIT] = SIT.ATIVO;
    c[LG.CRIADO] = c[LG.CRIADO] || new Date(deps.now()).toISOString();
    c[LG.DECIDIDO] = new Date(deps.now()).toISOString();
    c[LG.DIGITADO] = email;
    c[LG.CODIGO] = "";
    c[LG.CODIGO_EXP] = "";
    c[LG.CODIGO_TENT] = 0;
    definirSenha_(secrets, deps, c, body.chave);
    if (existente) deps.logins.update(existente.linha, c);
    else deps.logins.add(c);
    enviarEmailSeguro_(
      deps,
      email,
      "Finan.: login e senha criados",
      "Olá, " + nome + "!\n\nAgora você também pode entrar no Finan. com e-mail (ou login: " + login + ") e senha, além da sua conta Google.\n"
    );
    return { criado: true };
  });
}

// ---------------------------------------------------------------------------
// Push notifications (2026-10-10): a device token for Firebase Cloud
// Messaging, so the daily lembretes trigger can also tap a notification on
// the phone/computer, not only e-mail. Anyone signed in — Google or e-mail+
// senha — may register their OWN device; this is opt-in convenience (it only
// lets the script find where to push TO), never a permission grant, so there
// is no role check beyond "proved who they are" (handleRequest already did
// that before despachar_ runs).
// ---------------------------------------------------------------------------

// body.pushToken, never body.token — the latter is already the auth token
// handleRequest reads before despachar_ ever runs; reusing that name here
// would silently register the person's Google/session token as if it were an
// FCM device token instead of the real one the client means to send.
function actionRegistrarPush_(deps, email, body) {
  const token = typeof body.pushToken === "string" ? body.pushToken.trim() : "";
  if (!token || token.length > 4096) throw new GatewayError_(400, "Token inválido.");
  if (!deps.pushTokens) throw new GatewayError_(400, "Ação indisponível.");
  deps.pushTokens.add(email, token);
  return { registrado: true };
}

// Push tokens live in the registry spreadsheet (same bootstrap pattern as
// loginsDeps_/requestsDeps_ above) — this is cross-company infrastructure
// data (a device belongs to a PERSON, not to one company's spreadsheet), not
// business data, so it never touches a company sheet.
const PUSH_TOKENS_TAB = "PushTokens";
const PUSH_TOKEN_HEADERS = ["E-mail", "Token", "Criado em", "Último confirmado em"];

function pushTokensDeps_(cache) {
  const props = PropertiesService.getScriptProperties();

  function planilha_() {
    let id = props.getProperty(REGISTRY_PROP);
    if (!id) {
      const criada = Sheets.Spreadsheets.create({ properties: { title: REGISTRY_TITLE }, sheets: [{ properties: { title: "Empresas" } }] });
      id = criada.spreadsheetId;
      Sheets.Spreadsheets.Values.update({ values: [["ID da planilha", "Empresa", "Criada em", "Criada por", "Ativa", "Segmento", "Teste expira em", "Aviso de teste enviado em"]] }, id, "Empresas!A1:H1", { valueInputOption: "RAW" });
      props.setProperty(REGISTRY_PROP, id);
    }
    const titulos = (Sheets.Spreadsheets.get(id, { fields: "sheets.properties.title" }).sheets || []).map((x) => x.properties.title);
    if (titulos.indexOf(PUSH_TOKENS_TAB) === -1) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: PUSH_TOKENS_TAB } } }] }, id);
      Sheets.Spreadsheets.Values.update({ values: [PUSH_TOKEN_HEADERS] }, id, PUSH_TOKENS_TAB + "!A1:D1", { valueInputOption: "RAW" });
    }
    return id;
  }

  return {
    list: () => {
      const guardado = cache.get("push_list");
      if (guardado) return JSON.parse(guardado);
      if (!props.getProperty(REGISTRY_PROP)) return [];
      const dados = Sheets.Spreadsheets.Values.get(planilha_(), PUSH_TOKENS_TAB + "!A2:D", { valueRenderOption: "UNFORMATTED_VALUE" });
      const lista = (dados.values || [])
        .map((linha, i) => ({ linha: i + 2, email: canonEmail_(String(linha[0] || "")), token: String(linha[1] || "") }))
        .filter((l) => l.email && l.token);
      cache.put("push_list", JSON.stringify(lista), 20);
      return lista;
    },
    add: (email, token) => {
      const id = planilha_();
      const canon = canonEmail_(email);
      const dados = Sheets.Spreadsheets.Values.get(id, PUSH_TOKENS_TAB + "!A2:D", { valueRenderOption: "UNFORMATTED_VALUE" }).values || [];
      const agora = new Date().toISOString();
      for (let i = 0; i < dados.length; i += 1) {
        if (String(dados[i][1] || "") === token) {
          // Same device registering again — just confirm it's still this
          // e-mail's (a device can change hands/accounts) and refresh the
          // "last confirmed" stamp, keeping the original "Criado em".
          Sheets.Spreadsheets.Values.update(
            { values: [[canon, token, dados[i][2] || agora, agora]] },
            id,
            PUSH_TOKENS_TAB + "!A" + (i + 2) + ":D" + (i + 2),
            { valueInputOption: "RAW" }
          );
          cache.remove("push_list");
          return;
        }
      }
      const proxima = dados.length + 2;
      Sheets.Spreadsheets.Values.update(
        { values: [[canon, token, agora, agora]] },
        id,
        PUSH_TOKENS_TAB + "!A" + proxima + ":D" + proxima,
        { valueInputOption: "RAW" }
      );
      cache.remove("push_list");
    },
    // A dead/unregistered token (FCM's answer when the app was uninstalled or
    // notification permission revoked) is blanked, not left to fail forever.
    remove: (token) => {
      const id = planilha_();
      const dados = Sheets.Spreadsheets.Values.get(id, PUSH_TOKENS_TAB + "!A2:D", { valueRenderOption: "UNFORMATTED_VALUE" }).values || [];
      for (let i = 0; i < dados.length; i += 1) {
        if (String(dados[i][1] || "") === token) {
          Sheets.Spreadsheets.Values.update(
            { values: [["", "", "", ""]] },
            id,
            PUSH_TOKENS_TAB + "!A" + (i + 2) + ":D" + (i + 2),
            { valueInputOption: "RAW" }
          );
          cache.remove("push_list");
          return;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// E-mail -> empresa index (2026-10-28, "SaaS Fase 2" scaling prerequisite —
// see CLAUDE.md). Problem: actionMe_ runs on EVERY login, for EVERY user, and
// used to read EVERY company's Usuários tab to find which ones that e-mail
// belongs to — fine at ~20 companies, but login gets slower for EVERYONE as
// the company count grows, long before MAX_COMPANIES is ever hit. This index
// (a tab in the registry spreadsheet, one row per e-mail+company membership)
// turns that into "read the companies this e-mail is actually in," typically
// one Sheets read total instead of one per company.
//
// Kept correct three ways, cheapest/most-common first:
//  1. substituirEmpresa() is called after every write to a company's
//     Usuários tab (actionUpdateValues_, actionCreateCompany_) — the index
//     entry is only ever as stale as the time between a Usuários edit and
//     the next login, not between logins.
//  2. actionMe_/autorizadoEmAlgumaEmpresa_ NEVER trust the index blindly for
//     who gets access — they only use it to narrow which companies' real
//     Usuários tab to read (getAccess_/loadUsuarios_, both live). A stale or
//     missing index entry can only make a login slower (falls back to
//     scanning every company), never grant access it shouldn't.
//  3. A daily trigger (reconstruirIndiceEmailsAgendado, below) rebuilds the
//     whole index from the real Usuários tabs — a safety net for the one
//     case the write-hook above can't catch: someone editing a Usuários tab
//     directly in Google Sheets, bypassing this app entirely.
//
// Deploy safety: the index starts EMPTY on a fresh deploy (no backfill
// needed before going live). actionMe_ falls back to the old full-company
// scan whenever the index has nothing for an e-mail yet, and — the important
// part — that fallback scan opportunistically indexes whatever it finds, so
// only a person's FIRST login after this ships pays the old cost; every
// login after that is fast, with no manual migration step required (running
// instalarGatilhoIndiceEmails once is still worth doing, for the drift
// safety net in point 3, but nothing breaks before that happens).
// ---------------------------------------------------------------------------

const INDICE_EMAILS_TAB = "ÍndiceEmails";
const INDICE_EMAILS_HEADERS = ["E-mail", "ID da planilha"];

function indiceEmailsDeps_(cache) {
  const props = PropertiesService.getScriptProperties();

  function planilha_() {
    let id = props.getProperty(REGISTRY_PROP);
    if (!id) {
      const criada = Sheets.Spreadsheets.create({ properties: { title: REGISTRY_TITLE }, sheets: [{ properties: { title: "Empresas" } }] });
      id = criada.spreadsheetId;
      Sheets.Spreadsheets.Values.update({ values: [["ID da planilha", "Empresa", "Criada em", "Criada por", "Ativa", "Segmento", "Teste expira em", "Aviso de teste enviado em"]] }, id, "Empresas!A1:H1", { valueInputOption: "RAW" });
      props.setProperty(REGISTRY_PROP, id);
    }
    const titulos = (Sheets.Spreadsheets.get(id, { fields: "sheets.properties.title" }).sheets || []).map((x) => x.properties.title);
    if (titulos.indexOf(INDICE_EMAILS_TAB) === -1) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: INDICE_EMAILS_TAB } } }] }, id);
      Sheets.Spreadsheets.Values.update({ values: [INDICE_EMAILS_HEADERS] }, id, INDICE_EMAILS_TAB + "!A1:B1", { valueInputOption: "RAW" });
    }
    return id;
  }

  function lerTudoCru_() {
    if (!props.getProperty(REGISTRY_PROP)) return [];
    return Sheets.Spreadsheets.Values.get(planilha_(), INDICE_EMAILS_TAB + "!A2:B", { valueRenderOption: "UNFORMATTED_VALUE" }).values || [];
  }

  function lerTudo_() {
    const guardado = cache.get("idxe_tudo");
    if (guardado) return JSON.parse(guardado);
    const linhas = lerTudoCru_()
      .map((linha) => ({ email: String(linha[0] || ""), spreadsheetId: String(linha[1] || "") }))
      .filter((l) => l.email && l.spreadsheetId);
    cache.put("idxe_tudo", JSON.stringify(linhas), 20);
    return linhas;
  }

  return {
    listarEmpresasDoEmail: (canon) => lerTudo_().filter((l) => l.email === canon).map((l) => l.spreadsheetId),
    // Narrow, additive write for the self-healing fallback path in actionMe_
    // — adds one membership if it is not already there. Never removes
    // anything, so it can never be the reason a real membership disappears.
    adicionar: (canon, spreadsheetId) => {
      const id = planilha_();
      const existentes = lerTudoCru_();
      const jaTem = existentes.some((linha) => String(linha[0] || "") === canon && String(linha[1] || "") === spreadsheetId);
      if (jaTem) return;
      const proxima = existentes.length + 2;
      Sheets.Spreadsheets.Values.update({ values: [[canon, spreadsheetId]] }, id, INDICE_EMAILS_TAB + "!A" + proxima + ":B" + proxima, { valueInputOption: "RAW" });
      cache.remove("idxe_tudo");
    },
    // The authoritative sync, called after every real Usuários write: throws
    // away every existing index row for this ONE company and replaces it
    // with its current real membership. Simpler and safer than trying to
    // patch a single row from a write's old/new values (a removal's write
    // only carries blanks, never the e-mail that used to be there).
    substituirEmpresa: (spreadsheetId, emails) => {
      const id = planilha_();
      const existentes = lerTudoCru_();
      const deOutrasEmpresas = existentes
        .filter((linha) => String(linha[1] || "") !== spreadsheetId)
        .map((linha) => [String(linha[0] || ""), String(linha[1] || "")]);
      const novasLinhas = deOutrasEmpresas.concat(emails.map((e) => [e, spreadsheetId]));
      if (existentes.length) Sheets.Spreadsheets.Values.clear({}, id, INDICE_EMAILS_TAB + "!A2:B" + (existentes.length + 1));
      if (novasLinhas.length) {
        Sheets.Spreadsheets.Values.update({ values: novasLinhas }, id, INDICE_EMAILS_TAB + "!A2:B" + (novasLinhas.length + 1), { valueInputOption: "RAW" });
      }
      cache.remove("idxe_tudo");
    },
  };
}

// Re-reads one company's real Usuários tab and makes the index match it
// exactly. Called right after every write to that tab (add/edit/remove a
// person, or the very first bootstrap row) — deps.cache.remove("usr_"+id)
// must already have run before this, so loadUsuarios_ here sees the fresh
// data, not the 20 s cache of the pre-write state.
function reindexarEmpresaUsuarios_(deps, spreadsheetId) {
  if (!deps.indiceEmails) return;
  let usuarios;
  try {
    usuarios = loadUsuarios_(deps, spreadsheetId);
  } catch (err) {
    return; // tab unreadable right now — the daily reconciliation will catch it
  }
  deps.indiceEmails.substituirEmpresa(spreadsheetId, (usuarios || []).map((u) => u.chave));
}

// ---------------------------------------------------------------------------
// Daily reconciliation trigger — the drift safety net described above, same
// manual-one-time-install pattern as instalarGatilhoLembretes/
// instalarGatilhoCotaDeEmail (open the Apps Script editor, select
// instalarGatilhoIndiceEmails, press Run, authorize if asked; idempotent, so
// re-running after a redeploy is harmless but still a step done by hand).
// ---------------------------------------------------------------------------

function reconstruirIndiceEmailsTodasEmpresas_(deps) {
  const empresas = companyMap_(deps);
  let falhas = 0;
  Object.keys(empresas).forEach((spreadsheetId) => {
    try {
      reindexarEmpresaUsuarios_(deps, spreadsheetId);
    } catch (err) {
      falhas += 1;
      console.error("Índice de e-mails — falhou para " + empresas[spreadsheetId].empresa + ": " + err.message);
    }
  });
  return { empresas: Object.keys(empresas).length, falhas: falhas };
}

function reconstruirIndiceEmailsAgendado() {
  const deps = realDeps_();
  const resultado = reconstruirIndiceEmailsTodasEmpresas_(deps);
  console.log("Índice de e-mails reconstruído: " + resultado.empresas + " empresa(s), " + resultado.falhas + " falha(s).");
}

function instalarGatilhoIndiceEmails() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "reconstruirIndiceEmailsAgendado") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("reconstruirIndiceEmailsAgendado").timeBased().everyDays(1).atHour(5).create();
  console.log("Gatilho diário instalado: reconstruirIndiceEmailsAgendado, por volta das 5h.");
}

// ---- sending: Firebase Cloud Messaging (push) and WhatsApp (Meta Cloud API) ----
// Both are configured entirely through Script Properties, never hardcoded, and
// both are silent no-ops until configured (see CLAUDE.md for the exact
// property names and values) — deliberately so a deploy of this code, before
// either is set up, changes nothing about today's behavior. Only ever reached
// through deps.push/deps.whatsapp (set in realDeps_ below): the pure logic in
// executarVerificacaoLembretes_ never calls Utilities/PropertiesService/
// UrlFetchApp directly, so it stays testable with mocked deps (see
// verifyGoogleToken_ for the same pattern, used since the very first version
// of this file).

function configFCM_() {
  const raw = PropertiesService.getScriptProperties().getProperty("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  try {
    const conta = JSON.parse(raw);
    if (!conta.client_email || !conta.private_key || !conta.project_id) return null;
    return conta;
  } catch (err) {
    return null;
  }
}

// Accepts either a string or a raw byte array (Utilities.base64EncodeWebSafe
// takes either) — used for both the JWT's text parts and its binary signature.
function base64Url_(valor) {
  return Utilities.base64EncodeWebSafe(valor).replace(/=+$/, "");
}

// A Google service-account JWT bearer exchange, signed with
// Utilities.computeRsaSha256Signature — the one asymmetric-crypto primitive
// Apps Script offers natively, which is exactly what this flow needs (no hand
// -rolled elliptic-curve code required, unlike raw Web Push/VAPID — see the
// CLAUDE.md note on why Firebase was chosen over implementing VAPID directly).
function obterTokenAcessoFCM_(deps, conta) {
  const cacheKey = "fcm_token_" + conta.project_id;
  const cached = deps.cache.get(cacheKey);
  if (cached) return cached;
  const agora = Math.floor(deps.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: conta.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };
  const semAssinar = base64Url_(JSON.stringify(header)) + "." + base64Url_(JSON.stringify(claims));
  // Signed as raw bytes, never routed through a String — a signature is binary,
  // and converting bytes <-> a JS string first risks silently corrupting it.
  const assinatura = Utilities.computeRsaSha256Signature(semAssinar, conta.private_key);
  const jwt = semAssinar + "." + base64Url_(assinatura);
  const resposta = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt },
    muteHttpExceptions: true,
  });
  if (resposta.getResponseCode() !== 200) {
    console.error("Autenticação FCM falhou: " + resposta.getContentText());
    return null;
  }
  const dados = JSON.parse(resposta.getContentText());
  deps.cache.put(cacheKey, dados.access_token, Math.min(3500, Number(dados.expires_in) || 3500));
  return dados.access_token;
}

// Returns true (sent), false (the token is dead — caller should forget it),
// or null (not configured / a transient error, neither sent nor dead). Takes
// a minimal {cache, now} rather than a full deps (see where this is wired in
// realDeps_ below) — just enough to cache the OAuth2 token between calls.
function enviarPushFCM_(deps, token, titulo, corpo, link) {
  const conta = configFCM_();
  if (!conta) return null;
  const acesso = obterTokenAcessoFCM_(deps, conta);
  if (!acesso) return null;
  const resposta = UrlFetchApp.fetch(
    "https://fcm.googleapis.com/v1/projects/" + conta.project_id + "/messages:send",
    {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + acesso },
      payload: JSON.stringify({
        message: {
          token: token,
          notification: { title: titulo, body: corpo },
          webpush: { fcm_options: { link: link } },
        },
      }),
      muteHttpExceptions: true,
    }
  );
  const codigo = resposta.getResponseCode();
  if (codigo >= 200 && codigo < 300) return true;
  const texto = resposta.getContentText();
  if (codigo === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(texto)) return false;
  console.error("Push FCM falhou: " + codigo + " " + texto);
  return null;
}

// One fixed, verified WhatsApp contact (Meta's free test-number tier caps at
// 5 verified recipients total — see CLAUDE.md), platform-wide rather than
// tied to one company: a template message (required for a business-initiated
// message outside a 24h customer reply window) with two parameters, in the
// exact order the approved template must use: {{1}} = quantidade, {{2}} =
// empresa. "pt_BR" must match the template's own approved language.
function enviarWhatsAppTeste_(totalContas, empresaNome) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("WHATSAPP_TOKEN");
  const phoneId = props.getProperty("WHATSAPP_PHONE_NUMBER_ID");
  const template = props.getProperty("WHATSAPP_TEMPLATE_NAME");
  const numero = props.getProperty("WHATSAPP_NUMERO_TESTE");
  if (!token || !phoneId || !template || !numero) return; // not configured yet

  const resposta = UrlFetchApp.fetch("https://graph.facebook.com/v21.0/" + phoneId + "/messages", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      messaging_product: "whatsapp",
      to: numero,
      type: "template",
      template: {
        name: template,
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: String(totalContas) }, { type: "text", text: empresaNome }],
          },
        ],
      },
    }),
    muteHttpExceptions: true,
  });
  const codigo = resposta.getResponseCode();
  if (codigo < 200 || codigo >= 300) console.error("WhatsApp falhou: " + codigo + " " + resposta.getContentText());
}

function resumoDoLogin_(l) {
  return {
    email: limparEmail_(l.c[LG.DIGITADO]),
    nome: String(l.c[LG.NOME] || ""),
    login: String(l.c[LG.LOGIN] || ""),
    funcao: String(l.c[LG.FUNCAO] || ""),
    empresa: String(l.c[LG.EMPRESA] || ""),
    mensagem: String(l.c[LG.MSG] || ""),
    situacao: String(l.c[LG.SIT]),
    criadoEm: String(l.c[LG.CRIADO] || ""),
    ultimoAcesso: String(l.c[LG.ULTIMO] || ""),
  };
}

function acaoPwListar_(deps, email) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const todos = deps.logins.list();
  return {
    pendentes: todos.filter((l) => l.c[LG.SIT] === SIT.APROVACAO).map(resumoDoLogin_),
    ativos: todos.filter((l) => l.c[LG.SIT] === SIT.ATIVO).map(resumoDoLogin_),
    outros: todos.filter((l) => l.c[LG.SIT] === SIT.RECUSADO || l.c[LG.SIT] === SIT.BLOQUEADO).slice(-20).map(resumoDoLogin_),
  };
}

// acao: aprovar / recusar (of a pending one), bloquear (of an active one), reativar (of a blocked / declined one).
function acaoPwDecidir_(deps, email, body) {
  if (!isAdminEmail_(deps, email)) throw denied_();
  const canon = canonEmail_(limparEmail_(body.email));
  const acao = body.acao;
  const regras = {
    aprovar: { de: [SIT.APROVACAO], para: SIT.ATIVO },
    recusar: { de: [SIT.APROVACAO], para: SIT.RECUSADO },
    bloquear: { de: [SIT.ATIVO], para: SIT.BLOQUEADO },
    reativar: { de: [SIT.BLOQUEADO, SIT.RECUSADO], para: SIT.ATIVO },
  };
  const regra = Object.prototype.hasOwnProperty.call(regras, acao) ? regras[acao] : null;
  if (!regra) throw new GatewayError_(400, "Ação inválida.");
  const nota = cleanText_(body.nota, 200, false);
  return deps.lock(() => {
    const login = acharLogin_(deps, canon);
    if (!login) throw new GatewayError_(400, "Login não encontrado.");
    if (regra.de.indexOf(login.c[LG.SIT]) === -1) throw new GatewayError_(400, "Este login não está mais nessa situação.");
    const c = login.c.slice();
    c[LG.SIT] = regra.para;
    c[LG.DECIDIDO] = new Date(deps.now()).toISOString();
    if (acao === "bloquear") c[LG.VERSAO] = Number(c[LG.VERSAO]) + 1; // ends every open session at once
    deps.logins.update(login.linha, c);
    if (acao === "aprovar" || acao === "recusar") {
      const para = limparEmail_(c[LG.DIGITADO]);
      enviarEmailSeguro_(
        deps,
        para,
        acao === "aprovar" ? "Finan.: seu acesso foi liberado" : "Finan.: sobre o seu cadastro",
        acao === "aprovar"
          ? "Olá, " + c[LG.NOME] + ".\n\nSeu cadastro foi aprovado. Entre em " + deps.config.APP_URL + " com o seu e-mail (" + para + ") e a senha que você criou.\n\nO acesso aos dados de uma empresa depende de o administrador dela cadastrar o seu e-mail.\n"
          : "Olá, " + c[LG.NOME] + ".\n\nNão foi possível aprovar o seu cadastro agora." + (nota ? "\n\n" + nota : "") + "\n"
      );
    }
    return { situacao: regra.para };
  });
}
