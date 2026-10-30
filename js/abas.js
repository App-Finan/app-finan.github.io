// Which tab of the company's spreadsheet plays which role, and what layout each
// one was found to have. Defaults are the original names ("Lançamento",
// "Estoque", "Lojas"...); a company whose tabs are named differently is
// "connected" once by its Master (Ajustes → Conectar planilha), which writes a
// small "Configuração" tab. Layouts (column positions) are NOT configured: they
// are detected on every load (js/esquema.js) and remembered here only so the
// forms still know where to write while offline.

const ABA_CONFIG = "Configuração";
const ABAS_LISTAS_PADRAO = {
  lojas: "Lojas",
  contas: "Contas",
  empresas: "Empresas",
  categorias: "Categoria",
  pessoas: "Pessoa",
  produtos: "Produto",
  tiposProduto: "Tipo de Produto",
  marcas: "Marcas",
};

let abasConfiguradas = {};
let esquemasEmMemoria = {};
// Preenchido por tentarAutoCorrigirAba quando ela acha e grava sozinha uma
// aba renomeada (ex.: "Lançamento" -> "Lançamento geral"). Zerado no início
// de cada carregamento (resetarAbasDaEmpresa) para nunca mostrar um aviso de
// uma correção de uma sessão/empresa anterior.
let ultimaAutoCorrecaoAbas = [];

function chaveArmazenamento(nome) {
  return `financegold_${nome}_${CONFIG.SPREADSHEET_ID}`;
}

function nomeAba(papel) {
  if (papel === "lancamentos") return abasConfiguradas.lancamentos || CONFIG.SHEET_NAME || "Lançamento";
  if (papel === "estoque") return abasConfiguradas.estoque || "Estoque";
  return abasConfiguradas[`lista:${papel}`] || ABAS_LISTAS_PADRAO[papel];
}

// 'Tipo de Produto'!A2:D — always quoted, so any tab name works.
function intervaloAba(nome, celulas) {
  return `'${String(nome).replace(/'/g, "''")}'!${celulas}`;
}

function resetarAbasDaEmpresa() {
  abasConfiguradas = {};
  esquemasEmMemoria = {};
  ultimaAutoCorrecaoAbas = [];
}

// Reads the "Configuração" tab (papel, aba). A company without it uses the
// default names. Only a real connection problem is passed on; a missing tab is
// simply "no configuration".
async function carregarConfiguracaoAbas(token) {
  const chave = chaveArmazenamento("abas");
  try {
    const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(ABA_CONFIG, "A2:C"), token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const config = {};
    rows.forEach((row) => {
      const papel = typeof row[0] === "string" ? row[0].trim() : "";
      const aba = typeof row[1] === "string" ? row[1].trim() : "";
      if (papel && aba) config[papel] = aba;
    });
    abasConfiguradas = config;
    try {
      localStorage.setItem(chave, JSON.stringify(config));
    } catch (err) {
      // best effort
    }
  } catch (err) {
    if (err && err.sessionExpired) throw err;
    if (isNetworkError(err)) {
      try {
        abasConfiguradas = JSON.parse(localStorage.getItem(chave) || "{}");
      } catch (e) {
        abasConfiguradas = {};
      }
      return abasConfiguradas;
    }
    abasConfiguradas = {}; // no Configuração tab (or not readable): defaults
  }
  return abasConfiguradas;
}

// The tab's rows, or a plain-language error when the tab does not exist.
async function lerLinhasDaAba(papel, token) {
  const aba = nomeAba(papel);
  try {
    return await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(aba, "A1:BZ"), token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (err) {
    if (err && (err.sessionExpired || isNetworkError(err))) throw err;
    let titulos = null;
    try {
      titulos = await getSheetTitles(CONFIG.SPREADSHEET_ID, token);
    } catch (e) {
      titulos = null;
    }
    if (titulos && titulos.indexOf(aba) === -1) {
      // Auto-correção (2026-10-30): a aba esperada ("Lançamento"/"Estoque")
      // sumiu — provavelmente foi renomeada, não apagada. Só um Master pode
      // tentar: é o único perfil que o servidor deixa listar/ler QUALQUER
      // aba (actionGetValues_ no Code.gs) — para Editor/Visualizador, nem
      // vale tentar, cairia num 403 na hora. Reusa o mesmo motor de
      // classificação por nome+conteúdo que "Ajustes → Conectar planilha"
      // já usa manualmente (classificarAba, js/esquema.js) — só que aqui
      // automático, e só quando há exatamente UM candidato confiante (dois
      // candidatos, ou um nome parecido cujo conteúdo não bate, caem no erro
      // de sempre em vez de arriscar escrever na aba errada).
      if (isMaster(currentUserRole) && (papel === "lancamentos" || papel === "estoque") && titulos) {
        let detectado = null;
        try {
          detectado = await tentarAutoCorrigirAba(papel, titulos, token);
        } catch (e) {
          if (e && e.sessionExpired) throw e;
          detectado = null; // qualquer outro problema na tentativa: cai no erro normal abaixo
        }
        if (detectado) {
          ultimaAutoCorrecaoAbas.push({ papel: papel, nomeAntigo: aba, nomeNovo: detectado });
          return await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(detectado, "A1:BZ"), token, {
            valueRenderOption: "UNFORMATTED_VALUE",
          });
        }
      }
      const oque = papel === "lancamentos" ? "o fluxo de caixa" : "o estoque";
      const dica = isMaster(currentUserRole)
        ? `Abra Ajustes → Conectar planilha e escolha qual aba é ${oque}.`
        : "Peça ao administrador da empresa para conectar a planilha (Ajustes → Conectar planilha).";
      throw new Error(`A aba "${aba}" não existe nesta planilha. ${dica}`);
    }
    throw err;
  }
}

// Procura, entre as abas reais da planilha, uma única candidata confiante
// para o papel que sumiu — por nome (substring, ex. "lançamento" dentro de
// "lançamento geral") e, só pra confirmar, pelo conteúdo real das colunas
// (mesmo teste de classificarAba que "Conectar planilha" usa). Nunca chuta:
// zero ou mais de um candidato confirmado -> retorna null, sem gravar nada.
async function tentarAutoCorrigirAba(papel, titulos, token) {
  const reservadas = [ABA_CONFIG, "Usuários", "Configuração Fiscal"];
  const outroPapel = papel === "lancamentos" ? "estoque" : "lancamentos";
  const jaUsadas = [nomeAba(outroPapel)].concat(Object.keys(ABAS_LISTAS_PADRAO).map((k) => nomeAba(k)));
  const candidatosPorNome = titulos.filter((t) => {
    if (reservadas.indexOf(t) !== -1 || jaUsadas.indexOf(t) !== -1) return false;
    const nome = normalizarTexto(t);
    return NOMES_ABA[papel].some((n) => nome.indexOf(n) !== -1);
  });
  if (candidatosPorNome.length === 0) return null;

  const confirmados = [];
  for (let i = 0; i < candidatosPorNome.length; i += 1) {
    const nome = candidatosPorNome[i];
    let rows = [];
    try {
      rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(nome, "A1:BZ60"), token, {
        valueRenderOption: "UNFORMATTED_VALUE",
      });
    } catch (err) {
      if (err && (err.sessionExpired || isNetworkError(err))) throw err;
      continue; // não consegui ler essa candidata: ela simplesmente não confirma
    }
    const cls = classificarAba(nome, rows);
    if (cls.papel === papel && cls.nota >= 3) confirmados.push(nome);
  }
  if (confirmados.length !== 1) return null;

  const nomeDetectado = confirmados[0];
  try {
    await salvarAutoCorrecaoAba(papel, nomeDetectado, token);
  } catch (err) {
    if (err && err.sessionExpired) throw err;
    // Não consegui gravar (rede, corrida com outra aba sendo corrigida ao
    // mesmo tempo) — ainda assim uso a detecção só para este carregamento,
    // em vez de voltar ao erro antigo; na próxima vez tenta gravar de novo.
    abasConfiguradas[papel] = nomeDetectado;
  }
  return nomeDetectado;
}

// Grava só o papel detectado na aba Configuração, sem mexer em nenhuma outra
// linha já existente (ao contrário de salvarConexao em js/conectar.js, que
// reescreve a aba inteira a partir de uma varredura manual completa) — aqui
// só o papel que estava faltando é tocado.
async function salvarAutoCorrecaoAba(papel, nomeDaAba, token) {
  const existentes = {};
  try {
    const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(ABA_CONFIG, "A2:C"), token, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    rows.forEach((row) => {
      const p = typeof row[0] === "string" ? row[0].trim() : "";
      const a = typeof row[1] === "string" ? row[1].trim() : "";
      if (p && a) existentes[p] = a;
    });
  } catch (err) {
    if (err && (err.sessionExpired || isNetworkError(err))) throw err;
    await createSheetTab(CONFIG.SPREADSHEET_ID, ABA_CONFIG, token); // aba Configuração ainda não existe
  }
  existentes[papel] = nomeDaAba;
  await updateSheetRow(CONFIG.SPREADSHEET_ID, intervaloAba(ABA_CONFIG, "A1:B1"), ["Papel", "Aba"], token);
  const linhas = Object.keys(existentes).map((p) => [p, existentes[p]]);
  for (let i = 0; i < linhas.length; i += 1) {
    await updateSheetRow(CONFIG.SPREADSHEET_ID, intervaloAba(ABA_CONFIG, `A${i + 2}:B${i + 2}`), linhas[i], token);
  }
  abasConfiguradas = existentes;
  try {
    localStorage.setItem(chaveArmazenamento("abas"), JSON.stringify(existentes));
  } catch (e) {
    // best effort
  }
}

// Texto para o status de carregamento — "" se nada foi auto-corrigido.
function mensagemAutoCorrecaoAbas() {
  if (ultimaAutoCorrecaoAbas.length === 0) return "";
  const partes = ultimaAutoCorrecaoAbas.map((c) => {
    const oque = c.papel === "lancamentos" ? "o fluxo de caixa" : "o estoque";
    return `conectamos "${c.nomeNovo}" automaticamente como ${oque} (antes "${c.nomeAntigo}")`;
  });
  return `Aviso: ${partes.join("; ")}. Confira em Ajustes → Conectar planilha se não for isso.`;
}

function temListasConectadas() {
  return Object.keys(abasConfiguradas).some((k) => k.indexOf("lista:") === 0);
}

// --- layouts ---------------------------------------------------------------

function guardarEsquema(papel, esquema) {
  esquemasEmMemoria[`${CONFIG.SPREADSHEET_ID}:${papel}`] = esquema;
  try {
    localStorage.setItem(chaveArmazenamento(`esquema_${papel}`), JSON.stringify(esquema));
  } catch (err) {
    // best effort
  }
}

function obterEsquema(papel) {
  const memoria = esquemasEmMemoria[`${CONFIG.SPREADSHEET_ID}:${papel}`];
  if (memoria) return memoria;
  try {
    const bruto = localStorage.getItem(chaveArmazenamento(`esquema_${papel}`));
    if (bruto) return JSON.parse(bruto);
  } catch (err) {
    // fall through
  }
  return null;
}

// The layout used before adaptive reading existed (original columns).
function esquemaPadrao(papel) {
  const cols = Object.assign({}, POSICOES_PADRAO[papel]);
  return {
    papel: papel,
    linhaCabecalho: 1,
    cols: cols,
    largura: papel === "lancamentos" ? 10 : 16,
    cabecalho: [],
    extras: [],
    reconhecidos: [],
    incerto: false,
    rotuloEntrada: "Entrada",
    rotuloSaida: "Saída",
    saidaNegativa: true,
    codigoNoTexto: {},
  };
}

// The layout of the current company's tab: from this session, from the last
// load, or read now (first rows only) — used by writes.
async function garantirEsquema(papel, token) {
  const existente = obterEsquema(papel);
  if (existente) return existente;
  const rows = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(nomeAba(papel), "A1:BZ60"), token, {
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const esquema = detectarEsquema(rows, papel);
  guardarEsquema(papel, esquema);
  return esquema;
}

// The first empty row below the data. The column that always has a value (Data
// / Produto) gives the first candidate; then the rows from there are checked so
// nothing that is written in a recognised column (a "Total" line, a note) is
// ever overwritten. Unrecognised columns (a formula filled down the sheet) are
// ignored on purpose, or the new row would land below the whole formula area.
async function acharProximaLinha(papel, campoChave, token) {
  const esquema = await garantirEsquema(papel, token);
  const col = esquema.cols[campoChave];
  if (col === undefined) throw new Error(`Não encontrei a coluna "${NOMES_CAMPOS[campoChave]}" na planilha.`);
  const letra = colunaLetra(col);
  const primeira = esquema.linhaCabecalho + 1;
  const aba = nomeAba(papel);
  const colunaChave = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(aba, `${letra}${primeira}:${letra}`), token, {
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  let ultimo = -1;
  colunaChave.forEach((row, i) => {
    if (row[0] !== undefined && row[0] !== null && String(row[0]).trim() !== "") ultimo = i;
  });
  const candidata = ultimo === -1 ? primeira : primeira + ultimo + 1;

  const janela = 200;
  const abaixo = await fetchSheetValues(CONFIG.SPREADSHEET_ID, intervaloAba(aba, `A${candidata}:BZ${candidata + janela - 1}`), token, {
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const colunasDosCampos = Object.keys(esquema.cols).map((campo) => esquema.cols[campo]);
  for (let k = 0; k < janela; k += 1) {
    const linha = abaixo[k] || [];
    const ocupada = colunasDosCampos.some((c) => linha[c] !== undefined && linha[c] !== null && String(linha[c]).trim() !== "");
    if (!ocupada) return candidata + k;
  }
  return candidata + janela;
}

// Writes { coluna: valor } into one row, one contiguous block of columns at a
// time, so cells the app does not fill (a formula column, an unrecognised
// column) are never touched. The block holding the key column (Data /
// Produto) goes LAST: if the connection drops half-way, the row still looks
// empty to the app and the retry reuses it instead of leaving an orphan.
async function escreverColunas(papel, linha, valoresPorColuna, colunaChave, token) {
  const cols = Object.keys(valoresPorColuna).map(Number).sort((a, b) => a - b);
  const blocos = [];
  cols.forEach((c) => {
    const ultimo = blocos[blocos.length - 1];
    if (ultimo && ultimo[ultimo.length - 1] === c - 1) ultimo.push(c);
    else blocos.push([c]);
  });
  blocos.sort((a, b) => (b.indexOf(colunaChave) !== -1 ? -1 : 0) - (a.indexOf(colunaChave) !== -1 ? -1 : 0));
  for (let i = 0; i < blocos.length; i += 1) {
    const bloco = blocos[i];
    const range = intervaloAba(nomeAba(papel), `${colunaLetra(bloco[0])}${linha}:${colunaLetra(bloco[bloco.length - 1])}${linha}`);
    await updateSheetRow(CONFIG.SPREADSHEET_ID, range, bloco.map((c) => valoresPorColuna[c]), token);
  }
}
