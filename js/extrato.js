// Conciliação bancária (2026-10-18). Importa um extrato OFX ou CSV do banco,
// guarda cada transação na aba "Extrato Bancário" (uma linha por transação,
// nunca reescrita — só os campos Conciliado/"Lançamento vinculado" mudam
// depois) e ajuda a casar cada uma com um Lançamento real já existente, ou a
// criar um novo a partir dela. Ver js/extrato-ui.js para a tela. Fixo e
// posicional (como Fornecedores/Contas), NÃO roteado pelo motor adaptativo
// esquema.js — mesma razão das outras abas do ERP: um passo deliberadamente
// menor. Acesso: leitura geral, escrita Editor+Master (READ_TABS/WRITE_TABS
// em apps-script/Code.gs) — não guarda nenhum segredo.
const EXTRATO_SHEET_NAME = "Extrato Bancário";
const EXTRATO_HEADERS = ["Data", "Conta", "Descrição", "Valor", "Tipo", "Conciliado", "Lançamento vinculado", "Origem ID", "Importado em"];

async function ensureExtratoSheet(token) {
  try {
    const titles = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    if (!titles.includes(EXTRATO_SHEET_NAME)) {
      await createSheetTab(CONFIG.SPREADSHEET_ID, EXTRATO_SHEET_NAME, token);
      await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A1:I1`, EXTRATO_HEADERS, token);
    }
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
  }
}

// .conta guarda a mesma forma "N - Nome" que a própria coluna Conta do
// Lançamento usa (escolhida no import a partir da lista de Contas, não
// digitada à mão) — tirarCodigo() na hora de comparar/exibir, nunca aqui.
function parseExtratoRow(row, linha) {
  return {
    linha,
    data: sheetSerialToDate(row[0]),
    conta: row[1] ? String(row[1]) : "",
    descricao: row[2] ? String(row[2]) : "",
    valor: typeof row[3] === "number" ? row[3] : Number(row[3]) || 0,
    tipo: row[4] ? String(row[4]) : "",
    conciliado: row[5] === "Sim",
    lancamentoVinculado: row[6] ? Number(row[6]) : null,
    origemId: row[7] ? String(row[7]) : "",
    importadoEm: row[8] ? String(row[8]) : "",
    raw: row,
  };
}

async function fetchExtrato(token) {
  let rows;
  try {
    rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A2:I`, token, { valueRenderOption: "UNFORMATTED_VALUE" });
  } catch (err) {
    if (isNetworkError(err) || err.sessionExpired) throw err;
    return []; // tab may not exist yet — empty list, not an error
  }
  const itens = [];
  rows.forEach((row, index) => {
    if (!row[0]) return;
    itens.push(parseExtratoRow(row, index + 2));
  });
  return itens;
}

async function findNextExtratoRow(token) {
  const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A2:A`, token, { valueRenderOption: "UNFORMATTED_VALUE" });
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i][0]) return i + 2;
  }
  return rows.length + 2;
}

function dataParaSerialExtrato(date) {
  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

function hashSimplesExtrato(texto) {
  let h = 0;
  for (let i = 0; i < texto.length; i += 1) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// O FITID do OFX já é um identificador único de verdade; um CSV não tem
// nenhum, então usamos um hash de data+valor+descrição — suficiente para não
// duplicar ao reimportar um período que se sobrepõe, embora (ao contrário do
// FITID) duas transações genuinamente idênticas no mesmo dia num CSV
// colidiriam no mesmo id. Aceitável para o primeiro uso real: melhor perder
// uma repetição rara do que duplicar o comum (reimportar o mesmo arquivo).
function origemIdDaTransacao(t) {
  if (t.origemId) return "ofx:" + t.origemId;
  const chave = `${toInputDateValueUTC(t.data)}|${t.valor.toFixed(2)}|${(t.descricao || "").trim().toLowerCase()}`;
  return "h:" + hashSimplesExtrato(chave);
}

// Grava só as transações que ainda não existem na aba (por Origem ID) — a
// comparação é contra o que já está na planilha, nunca entre itens do mesmo
// arquivo (duas compras idênticas no mesmo dia são raras, mas legítimas).
// Escritas sequenciais (uma por vez, nunca em paralelo) para nunca duas
// delas calcularem a mesma "próxima linha vazia" — mesma limitação já
// conhecida de todo write-by-next-empty-row deste app.
async function importarExtratoTransacoes(transacoes, contaValue, token, aoProgredir) {
  const existentes = await fetchExtrato(token);
  const idsExistentes = new Set(existentes.map((e) => e.origemId));
  const novas = transacoes.filter((t) => !idsExistentes.has(origemIdDaTransacao(t)));

  let targetRow = await findNextExtratoRow(token);
  const agora = new Date().toLocaleString("pt-BR");
  for (let i = 0; i < novas.length; i += 1) {
    const t = novas[i];
    const row = [
      dataParaSerialExtrato(t.data),
      contaValue,
      t.descricao || "",
      t.valor,
      t.valor >= 0 ? "Entrada" : "Saída",
      "Não",
      "",
      origemIdDaTransacao(t),
      agora,
    ];
    await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A${targetRow}:I${targetRow}`, row, token);
    targetRow += 1;
    if (aoProgredir) aoProgredir(i + 1, novas.length);
  }
  return { importadas: novas.length, duplicadas: transacoes.length - novas.length };
}

async function marcarExtratoConciliado(item, linhaLancamento, token) {
  const row = (item.raw || []).slice();
  while (row.length < 9) row.push("");
  row[5] = "Sim";
  row[6] = linhaLancamento || "";
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A${item.linha}:I${item.linha}`, row, token);
}

async function desfazerConciliacaoExtrato(item, token) {
  const row = (item.raw || []).slice();
  while (row.length < 9) row.push("");
  row[5] = "Não";
  row[6] = "";
  await updateSheetRow(CONFIG.SPREADSHEET_ID, `'${EXTRATO_SHEET_NAME}'!A${item.linha}:I${item.linha}`, row, token);
}

// Cria o Lançamento que ainda não existia para esta transação do extrato,
// pela mesma função (submitLancamentoValues, js/form.js) que o formulário
// "Novo lançamento" e settleConta (Contas a Pagar/Receber) já usam — depois
// marca esta linha do extrato como conciliada, apontando para a linha criada.
async function criarLancamentoDeExtrato(item, { loja, empresa, categoria, pessoa, data }, token) {
  const lancamentoRow = await submitLancamentoValues(
    {
      data,
      tipo: item.valor >= 0 ? "Entrada" : "Saída",
      valor: Math.abs(item.valor),
      loja,
      conta: item.conta,
      empresa,
      categoria,
      pessoa,
      peso: "",
      observacao: `Lançamento criado a partir do extrato bancário — ${item.descricao}`,
      extras: [],
    },
    token
  );
  await marcarExtratoConciliado(item, lancamentoRow, token);
  return lancamentoRow;
}

// ---------------------------------------------------------------------------
// OFX — tanto o formato antigo "tag soup" (sem fechamento) quanto o XML
// (OFX 2.x, com fechamento) caem no mesmo regex, já que ele só procura
// "<TAG>conteúdo" até o próximo "<" ou fim de linha, com ou sem </TAG>.
// ---------------------------------------------------------------------------

function converterDataOfx(valor) {
  const m = String(valor || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return dataValida(Number(m[1]), Number(m[2]), Number(m[3]));
}

function campoOfx(bloco, tag) {
  const m = bloco.match(new RegExp("<" + tag + ">\\s*([^<\\r\\n]*)", "i"));
  return m ? m[1].trim() : "";
}

function parseOfx(texto) {
  const blocos = texto.split(/<STMTTRN>/i).slice(1);
  const transacoes = [];
  blocos.forEach((bloco) => {
    const fechaIdx = bloco.search(/<\/STMTTRN>/i);
    const corpo = fechaIdx === -1 ? bloco : bloco.slice(0, fechaIdx);
    const data = converterDataOfx(campoOfx(corpo, "DTPOSTED"));
    const valorTexto = campoOfx(corpo, "TRNAMT");
    const valor = valorTexto ? Number(valorTexto) : NaN;
    if (!data || !Number.isFinite(valor)) return;
    const descricao = campoOfx(corpo, "MEMO") || campoOfx(corpo, "NAME") || "";
    const fitid = campoOfx(corpo, "FITID");
    transacoes.push({ data, valor, descricao, origemId: fitid || null });
  });
  return transacoes;
}

// ---------------------------------------------------------------------------
// CSV genérico — exige cabeçalho com Data/Descrição/Valor (em qualquer
// ordem, qualquer um dos sinônimos abaixo); reusa converterData/converterNumero
// (js/esquema.js) para aceitar os mesmos formatos de data/dinheiro que o
// resto do app já entende.
// ---------------------------------------------------------------------------

const EXTRATO_CSV_SINONIMOS = {
  data: ["data", "dtlancamento", "dtmovimento", "dtposted"],
  descricao: ["descricao", "historico", "lancamento", "detalhes", "memo"],
  valor: ["valor", "valorlancamento", "montante", "amount"],
};

function normalizarCabecalhoExtratoCsv(texto) {
  return normalizarTexto(String(texto || "")).replace(/[^a-z0-9]/g, "");
}

function detectarDelimitadorExtratoCsv(linha) {
  return linha.split(";").length >= linha.split(",").length ? ";" : ",";
}

function parseCsvExtrato(texto) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!linhas.length) return [];
  const delim = detectarDelimitadorExtratoCsv(linhas[0]);
  const cabecalho = linhas[0].split(delim).map(normalizarCabecalhoExtratoCsv);
  const indices = {};
  Object.keys(EXTRATO_CSV_SINONIMOS).forEach((campo) => {
    const idx = cabecalho.findIndex((h) => EXTRATO_CSV_SINONIMOS[campo].some((s) => h.indexOf(s) !== -1));
    if (idx !== -1) indices[campo] = idx;
  });
  if (indices.data === undefined || indices.valor === undefined) {
    throw new Error('Não encontrei as colunas de Data e Valor no CSV. Exporte com um cabeçalho ("Data", "Descrição", "Valor").');
  }
  const transacoes = [];
  linhas.slice(1).forEach((linha) => {
    const celulas = linha.split(delim);
    const data = converterData(celulas[indices.data]);
    const valor = converterNumero(celulas[indices.valor]);
    if (!data || valor === null) return;
    const descricao = indices.descricao !== undefined ? (celulas[indices.descricao] || "").trim() : "";
    transacoes.push({ data, valor, descricao, origemId: null });
  });
  return transacoes;
}

function parseArquivoExtrato(nomeArquivo, texto) {
  const ehOfx = /\.ofx$/i.test(nomeArquivo) || /<OFX>/i.test(texto);
  return ehOfx ? parseOfx(texto) : parseCsvExtrato(texto);
}

// ---------------------------------------------------------------------------
// Sugestão de conciliação: mesma conta, mesmo valor absoluto, data a até 2
// dias de distância — qualquer coisa fora disso não é sugerida
// automaticamente (a pessoa sempre confirma ou cria um lançamento novo, nunca
// um vínculo automático sem olhar).
// ---------------------------------------------------------------------------

const EXTRATO_TOLERANCIA_DIAS = 2;

function sugerirLancamentoParaExtrato(item, lancamentos) {
  if (item.conciliado || !item.data) return null;
  const contaPlain = tirarCodigo(item.conta);
  const alvo = Math.abs(item.valor);
  const umDia = 86400000;
  let melhor = null;
  let melhorDiff = Infinity;
  lancamentos.forEach((l) => {
    if (!l.data || l.conta !== contaPlain) return;
    if (Math.abs(l.valor) !== alvo) return;
    const diffDias = Math.abs(l.data.getTime() - item.data.getTime()) / umDia;
    if (diffDias <= EXTRATO_TOLERANCIA_DIAS && diffDias < melhorDiff) {
      melhor = l;
      melhorDiff = diffDias;
    }
  });
  return melhor;
}
