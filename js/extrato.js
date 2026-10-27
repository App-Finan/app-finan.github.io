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
// CSV e .xlsx genéricos — o núcleo (interpretarLinhasExtrato, logo abaixo) é
// compartilhado pelos dois: um CSV já separado por linha/delimitador e um
// .xlsx lido por js/xlsx-leitor.js chegam aqui no mesmo formato (uma matriz
// de linhas, cada célula já separada — string vindo do CSV, string OU número
// vindo do .xlsx). Exige um cabeçalho com Data e (Valor, ou Crédito+Débito
// em colunas separadas), em qualquer ordem, qualquer um dos sinônimos
// abaixo; reusa converterData/converterNumero (js/esquema.js) para aceitar
// os mesmos formatos de data/dinheiro que o resto do app já entende
// (inclusive um número cru vindo do .xlsx como serial de data).
//
// Tolera também o formato "relatório de banco" que alguns bancos exportam
// (ex.: o extrato "net empresa" do Bradesco, visto num PDF real anexado pelo
// usuário — não um .xlsx verificado, ver a nota em CLAUDE.md) em vez de uma
// tabela limpa de uma transação por linha: a Data só aparece na primeira
// transação de cada dia (as de baixo herdam a última data vista), Crédito e
// Débito ficam em colunas separadas em vez de um Valor único com sinal, e o
// arquivo mistura "SALDO ANTERIOR"/linhas de "Total" e até outras tabelas
// (ex.: saldos de aplicação financeira) no mesmo arquivo.
// ---------------------------------------------------------------------------

const EXTRATO_SINONIMOS = {
  data: ["data", "dtlancamento", "dtmovimento", "dtposted", "dia"],
  descricao: ["descricao", "historico", "lancamento", "detalhes", "memo"],
  valor: ["valor", "valorlancamento", "montante", "amount"],
  credito: ["credito", "creditos"],
  debito: ["debito", "debitos"],
  documento: ["documento", "dcto", "numerodocumento", "nrdocumento"],
};

function normalizarCabecalhoExtratoCsv(texto) {
  return normalizarTexto(String(texto === undefined || texto === null ? "" : texto)).replace(/[^a-z0-9]/g, "");
}

function detectarDelimitadorExtratoCsv(linha) {
  return linha.split(";").length >= linha.split(",").length ? ";" : ",";
}

function acharColunasExtrato(celulasNormalizadas) {
  const indices = {};
  Object.keys(EXTRATO_SINONIMOS).forEach((campo) => {
    const idx = celulasNormalizadas.findIndex((h) => EXTRATO_SINONIMOS[campo].some((s) => h.indexOf(s) !== -1));
    if (idx !== -1) indices[campo] = idx;
  });
  return indices;
}

// Uma linha "parece" um cabeçalho de tabela quando pelo menos duas de suas
// células batem com algum campo conhecido — usado tanto para achar o
// cabeçalho de verdade no topo do arquivo quanto para detectar o INÍCIO de
// uma SEGUNDA tabela mais adiante no mesmo arquivo (relatórios de banco às
// vezes emendam várias tabelas diferentes, ex. extrato + saldos de aplicação
// financeira) e parar de importar ali, em vez de misturar dado de outra
// natureza com as transações reais.
function pareceCabecalhoExtrato(celulasNormalizadas) {
  let achados = 0;
  Object.keys(EXTRATO_SINONIMOS).forEach((campo) => {
    if (celulasNormalizadas.some((h) => EXTRATO_SINONIMOS[campo].some((s) => h.indexOf(s) !== -1))) achados += 1;
  });
  return achados >= 2;
}

// Linhas que não são transação nenhuma, mas aparecem misturadas com as
// transações de verdade nesse tipo de relatório de banco.
const EXTRATO_LINHAS_IGNORADAS = ["saldo anterior", "total", "totais"];

function linhaEhIgnoravelExtrato(celula) {
  const n = normalizarTexto(celula === undefined || celula === null ? "" : celula).trim();
  return EXTRATO_LINHAS_IGNORADAS.indexOf(n) !== -1;
}

// O núcleo comum: uma matriz de linhas -> lista de transações.
function interpretarLinhasExtrato(linhas) {
  if (!linhas || !linhas.length) return [];

  let indiceCabecalho = -1;
  let indices = null;
  for (let i = 0; i < linhas.length; i += 1) {
    const normalizadas = linhas[i].map(normalizarCabecalhoExtratoCsv);
    const candidatos = acharColunasExtrato(normalizadas);
    // Crédito/Débito podem vir só um dos dois (ex.: um extrato filtrado só
    // por créditos) — não exige os dois juntos, diferente do cálculo do
    // valor em si logo abaixo, que já trata um dos dois ausente como null.
    if (candidatos.data !== undefined && (candidatos.valor !== undefined || candidatos.credito !== undefined || candidatos.debito !== undefined)) {
      indiceCabecalho = i;
      indices = candidatos;
      break;
    }
  }
  if (indiceCabecalho === -1) {
    throw new Error('Não encontrei as colunas de Data e Valor (ou Crédito/Débito). Exporte com um cabeçalho ("Data", "Descrição", "Valor").');
  }

  const transacoes = [];
  let ultimaData = null;
  for (let i = indiceCabecalho + 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (!linha || linha.every((c) => c === "" || c === null || c === undefined)) continue;

    const normalizadas = linha.map(normalizarCabecalhoExtratoCsv);
    if (pareceCabecalhoExtrato(normalizadas)) break; // uma segunda tabela começando — para por aqui

    const celulaDescricao = indices.descricao !== undefined ? linha[indices.descricao] : undefined;
    if (linhaEhIgnoravelExtrato(celulaDescricao) || linhaEhIgnoravelExtrato(linha[indices.data])) continue;

    const dataLinha = converterData(linha[indices.data]);
    if (dataLinha) ultimaData = dataLinha;

    let valor = null;
    if (indices.valor !== undefined) {
      valor = converterNumero(linha[indices.valor]);
    } else {
      const credito = indices.credito !== undefined ? converterNumero(linha[indices.credito]) : null;
      const debito = indices.debito !== undefined ? converterNumero(linha[indices.debito]) : null;
      if (credito !== null && credito !== 0) valor = Math.abs(credito);
      else if (debito !== null && debito !== 0) valor = -Math.abs(debito);
    }

    if (valor === null) {
      // sem valor nesta linha: ou é lixo (cabeçalho de seção, rodapé, linha
      // em branco), ou é a continuação da descrição da transação anterior
      // (célula de texto que às vezes vem quebrada em duas linhas de
      // verdade, dependendo de como o banco gerou o arquivo).
      const texto = (celulaDescricao || "").toString().trim();
      if (texto && transacoes.length && !dataLinha) {
        const ultima = transacoes[transacoes.length - 1];
        ultima.descricao = (ultima.descricao + " " + texto).trim();
      }
      continue;
    }
    if (!ultimaData) continue; // valor sem nenhuma data ainda vista — não dá pra usar

    let descricao = (celulaDescricao || "").toString().replace(/\s*\n\s*/g, " ").trim();
    if (indices.documento !== undefined && linha[indices.documento]) {
      descricao = descricao ? `${descricao} (Dcto ${linha[indices.documento]})` : `Dcto ${linha[indices.documento]}`;
    }
    transacoes.push({ data: ultimaData, valor, descricao, origemId: null });
  }
  return transacoes;
}

function parseCsvExtrato(texto) {
  const linhasTexto = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!linhasTexto.length) return [];
  const delim = detectarDelimitadorExtratoCsv(linhasTexto[0]);
  const linhas = linhasTexto.map((l) => l.split(delim));
  return interpretarLinhasExtrato(linhas);
}

// nomeArquivo + um File já lido (não um ArrayBuffer/texto pronto) porque o
// .xlsx precisa ser lido como binário (arrayBuffer), diferente de
// OFX/CSV (texto) — cada formato só lê o arquivo do jeito que precisa.
async function parseArquivoExtratoAsync(file) {
  const nomeArquivo = file && file.name ? file.name : "";
  if (/\.xlsx$/i.test(nomeArquivo)) {
    const buffer = await file.arrayBuffer();
    const { linhas } = await lerXlsxComoLinhas(buffer);
    return interpretarLinhasExtrato(linhas);
  }
  const texto = await file.text();
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
