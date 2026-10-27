// Leitura de planilhas .xlsx no navegador, sem nenhuma biblioteca — um .xlsx
// é só um zip de arquivos XML. Construído para "Importar extrato" (ver
// js/extrato.js) aceitar também .xlsx, além de OFX/CSV, mas é genérico: lê a
// primeira aba de qualquer .xlsx como uma matriz de linhas/células, do mesmo
// jeito que um CSV já separado por vírgula ficaria — só que com números de
// verdade (não texto), o que já funciona de graça com os conversores de
// data/dinheiro do resto do app (converterData/converterNumero, js/esquema.js,
// que já entendem um número cru como serial de data — o mesmo epoch do Excel
// e do Google Sheets, 30/12/1899).
//
// Não precisa de biblioteca de descompressão: usa a DecompressionStream
// nativa do navegador ("deflate-raw") para arquivos realmente comprimidos (o
// que o Excel/Google Sheets gera); js/modelo.js (o gerador de .xlsx deste
// mesmo projeto) grava sem compressão (método 0, "store"), então os dois
// casos têm que funcionar — testado nos dois, ver testes/xlsx.html.
//
// Analisado a partir de um PDF real de extrato (Bradesco net empresa, não um
// .xlsx de verdade — ver a nota em CLAUDE.md), não um arquivo .xlsx
// verificado byte a byte: a parte de ZIP/XML abaixo é genérica e tem teste
// de ida-e-volta própria; o formato específico desse banco só foi confirmado
// estruturalmente, não testado contra o arquivo real.

function xlsxDescompressaoDisponivel() {
  return typeof DecompressionStream !== "undefined";
}

// ---------------------------------------------------------------------------
// Leitor de zip mínimo: só o necessário para listar as entradas pelo
// diretório central e extrair os bytes brutos de uma entrada pelo seu
// cabeçalho local (os dois existem porque o tamanho do "extra field" pode
// diferir entre o diretório central e o cabeçalho local do mesmo arquivo).
// ---------------------------------------------------------------------------

function lerU16Zip(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function lerU32Zip(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

// A assinatura do "fim do diretório central" (0x06054b50) normalmente fica
// bem no final do arquivo; procurar de trás pra frente numa janela cobre o
// caso raro de o zip ter um comentário (os .xlsx reais que vamos receber
// aqui nunca têm).
function acharFimDiretorioCentralZip(bytes) {
  const minimo = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= minimo; i -= 1) {
    if (lerU32Zip(bytes, i) === 0x06054b50) return i;
  }
  return -1;
}

function listarEntradasZip(bytes) {
  const fimPos = acharFimDiretorioCentralZip(bytes);
  if (fimPos === -1) throw new Error("não encontrei a estrutura de um zip válido");
  const totalEntradas = lerU16Zip(bytes, fimPos + 10);
  let pos = lerU32Zip(bytes, fimPos + 16);
  const entradas = [];
  const decodificador = new TextDecoder("utf-8");
  for (let i = 0; i < totalEntradas; i += 1) {
    if (lerU32Zip(bytes, pos) !== 0x02014b50) throw new Error("diretório central do zip corrompido");
    const metodo = lerU16Zip(bytes, pos + 10);
    const tamanhoComprimido = lerU32Zip(bytes, pos + 20);
    const tamanhoNome = lerU16Zip(bytes, pos + 28);
    const tamanhoExtra = lerU16Zip(bytes, pos + 30);
    const tamanhoComentario = lerU16Zip(bytes, pos + 32);
    const offsetLocal = lerU32Zip(bytes, pos + 42);
    const nome = decodificador.decode(bytes.subarray(pos + 46, pos + 46 + tamanhoNome));
    entradas.push({ nome: nome, metodo: metodo, tamanhoComprimido: tamanhoComprimido, offsetLocal: offsetLocal });
    pos += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return entradas;
}

function extrairBytesLocaisZip(bytes, entrada) {
  const pos = entrada.offsetLocal;
  if (lerU32Zip(bytes, pos) !== 0x04034b50) throw new Error("cabeçalho local do zip corrompido");
  const tamanhoNome = lerU16Zip(bytes, pos + 26);
  const tamanhoExtra = lerU16Zip(bytes, pos + 28);
  const inicioDados = pos + 30 + tamanhoNome + tamanhoExtra;
  return bytes.subarray(inicioDados, inicioDados + entrada.tamanhoComprimido);
}

async function inflarDeflateBruto(bytesComprimidos) {
  const fluxo = new DecompressionStream("deflate-raw");
  const escritor = fluxo.writable.getWriter();
  escritor.write(bytesComprimidos);
  escritor.close();
  const resposta = new Response(fluxo.readable);
  const buffer = await resposta.arrayBuffer();
  return new Uint8Array(buffer);
}

// null se a entrada não existir (ex.: sharedStrings.xml, que nem todo .xlsx tem).
async function lerArquivoDoZip(bytes, entradas, nome) {
  const entrada = entradas.filter((e) => e.nome === nome)[0];
  if (!entrada) return null;
  const comprimidos = extrairBytesLocaisZip(bytes, entrada);
  const planos = entrada.metodo === 0 ? comprimidos : await inflarDeflateBruto(comprimidos);
  return new TextDecoder("utf-8").decode(planos);
}

// ---------------------------------------------------------------------------
// XML via DOMParser nativo (entidades e aninhamento ficam corretos de graça
// — nenhum regex para isto).
// ---------------------------------------------------------------------------

function parseXmlXlsx(texto) {
  return new DOMParser().parseFromString(texto, "application/xml");
}

// "AB12" -> 27 (índice de coluna, 0-based)
function indiceDaColunaXlsx(ref) {
  const letras = (String(ref || "").match(/^[A-Z]+/) || [""])[0];
  let n = 0;
  for (let i = 0; i < letras.length; i += 1) n = n * 26 + (letras.charCodeAt(i) - 64);
  return n > 0 ? n - 1 : 0;
}

function textoDaStringCompartilhadaXlsx(noSi) {
  // <si><t>texto</t></si> (texto simples) ou <si><r><t>pedaço</t></r>...</si>
  // (texto com formatação mista, cada <r> é um "run") — os dois casos têm
  // tags <t>, então pegar todas e juntar cobre ambos.
  return Array.from(noSi.getElementsByTagName("t")).map((t) => t.textContent).join("");
}

function lerSharedStringsXlsx(xmlTexto) {
  if (!xmlTexto) return [];
  const doc = parseXmlXlsx(xmlTexto);
  return Array.from(doc.getElementsByTagName("si")).map(textoDaStringCompartilhadaXlsx);
}

// sheetN.xml -> matriz de linhas, densa (sem buraco de coluna: preenchida
// com "" onde a célula não existir na planilha de origem).
function lerPlanilhaComoLinhasXlsx(xmlTexto, sharedStrings) {
  const doc = parseXmlXlsx(xmlTexto);
  const linhasXml = Array.from(doc.getElementsByTagName("row"));
  let maiorColuna = -1;
  const linhasBrutas = linhasXml.map((linhaXml) => {
    const celulas = {};
    Array.from(linhaXml.children).forEach((c) => {
      if (!c.tagName || c.tagName.toLowerCase() !== "c") return;
      const ref = c.getAttribute("r") || "";
      const idx = ref ? indiceDaColunaXlsx(ref) : 0;
      maiorColuna = Math.max(maiorColuna, idx);
      const tipo = c.getAttribute("t") || "";
      const vNo = c.getElementsByTagName("v")[0];
      let valor;
      if (tipo === "s") {
        const indice = vNo ? Number(vNo.textContent) : NaN;
        valor = Number.isFinite(indice) ? sharedStrings[indice] || "" : "";
      } else if (tipo === "inlineStr") {
        const isNo = c.getElementsByTagName("is")[0];
        valor = isNo ? Array.from(isNo.getElementsByTagName("t")).map((t) => t.textContent).join("") : "";
      } else if (tipo === "str" || tipo === "e") {
        // "str": resultado de fórmula como texto; "e": célula com erro (#N/A...) — mantém como texto mesmo
        valor = vNo ? vNo.textContent : "";
      } else if (tipo === "b") {
        valor = vNo && vNo.textContent === "1" ? "Verdadeiro" : "Falso";
      } else {
        // número puro — datas chegam aqui como número cru, ver o comentário
        // no topo do arquivo sobre converterData já entender isso
        if (!vNo || vNo.textContent === "") valor = "";
        else {
          const numero = Number(vNo.textContent);
          valor = Number.isFinite(numero) ? numero : vNo.textContent;
        }
      }
      celulas[idx] = valor;
    });
    return celulas;
  });
  return linhasBrutas.map((celulas) => {
    const linha = [];
    for (let i = 0; i <= maiorColuna; i += 1) linha.push(Object.prototype.hasOwnProperty.call(celulas, i) ? celulas[i] : "");
    return linha;
  });
}

// O atributo de relações usa o prefixo "r:" por convenção em todo .xlsx real
// (Excel, Google Sheets, e o próprio js/modelo.js) — getAttribute direto
// cobre isso; o fallback varre os atributos por um terminado em ":id" para o
// caso raro de outra ferramenta usar um prefixo de namespace diferente.
function idDeRelacaoXlsx(noSheet) {
  const direto = noSheet.getAttribute("r:id");
  if (direto) return direto;
  const attrs = noSheet.attributes || [];
  for (let i = 0; i < attrs.length; i += 1) {
    if (/:id$/.test(attrs[i].name)) return attrs[i].value;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Função principal
// ---------------------------------------------------------------------------

// arrayBuffer -> { abas: ["Nome1", ...], linhas: [[...], ...] } da PRIMEIRA
// aba do arquivo (na ordem em que foi salva). Lança um erro com mensagem em
// português se o arquivo não for um .xlsx válido, ou se o navegador não
// souber descomprimir "deflate-raw" nativamente (Safari bem antigo).
async function lerXlsxComoLinhas(arrayBuffer) {
  if (!xlsxDescompressaoDisponivel()) {
    throw new Error("Este navegador não consegue abrir arquivos .xlsx aqui. Atualize o navegador, ou exporte o extrato em CSV/OFX.");
  }
  const bytes = new Uint8Array(arrayBuffer);
  let entradas;
  try {
    entradas = listarEntradasZip(bytes);
  } catch (err) {
    throw new Error("Não consegui abrir este arquivo como .xlsx (" + err.message + ").");
  }

  const workbookTexto = await lerArquivoDoZip(bytes, entradas, "xl/workbook.xml");
  if (!workbookTexto) throw new Error("Não encontrei xl/workbook.xml — este arquivo não parece ser um .xlsx válido.");
  const workbookDoc = parseXmlXlsx(workbookTexto);
  const folhas = Array.from(workbookDoc.getElementsByTagName("sheet")).map((no) => ({
    nome: no.getAttribute("name") || "",
    rId: idDeRelacaoXlsx(no),
  }));
  if (!folhas.length) throw new Error("Esta planilha não tem nenhuma aba.");

  const relsTexto = await lerArquivoDoZip(bytes, entradas, "xl/_rels/workbook.xml.rels");
  const alvoPorRid = {};
  if (relsTexto) {
    Array.from(parseXmlXlsx(relsTexto).getElementsByTagName("Relationship")).forEach((no) => {
      alvoPorRid[no.getAttribute("Id")] = no.getAttribute("Target");
    });
  }

  function caminhoDaFolhaXlsx(folha, indice) {
    const alvo = alvoPorRid[folha.rId];
    if (alvo) return /^\//.test(alvo) ? alvo.slice(1) : "xl/" + alvo.replace(/^\.?\//, "");
    return "xl/worksheets/sheet" + (indice + 1) + ".xml"; // sem rels (raro) — convenção padrão do formato
  }

  const sharedStringsTexto = await lerArquivoDoZip(bytes, entradas, "xl/sharedStrings.xml");
  const sharedStrings = lerSharedStringsXlsx(sharedStringsTexto);

  const primeiraFolhaTexto = await lerArquivoDoZip(bytes, entradas, caminhoDaFolhaXlsx(folhas[0], 0));
  if (!primeiraFolhaTexto) throw new Error('Não consegui ler a aba "' + folhas[0].nome + '" deste arquivo.');

  return { abas: folhas.map((f) => f.nome), linhas: lerPlanilhaComoLinhasXlsx(primeiraFolhaTexto, sharedStrings) };
}
