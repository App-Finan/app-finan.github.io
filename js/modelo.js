// Downloadable spreadsheet template (Ajustes → Conectar planilha → Baixar modelo)
// for companies that have no sheet yet or no idea how to lay one out. It is a
// real .xlsx (opens in Excel, Google Sheets, Numbers, LibreOffice), built here
// with no library: an .xlsx is a zip of small XML files, written uncompressed.
//
// Tabs: Instruções, Lançamento, Estoque, Fornecedores, Contas a Pagar, Contas a
// Receber, the support lists, and Exemplo (filled rows to copy the idea from —
// the data tabs themselves start empty). The headers are EXACTLY the ones the
// app (and the server-created companies, see companyTemplate_ in
// apps-script/Code.gs) use, with the words of the chosen segment. Helpful
// fill-in touches: date and money formats, dropdowns for Tipo / Vendido? /
// Status / Recorrente, header row frozen, list codes and "código - nome"
// filled automatically by formulas.
//
// Fornecedores/Contas a Pagar/Contas a Receber (2026-10-16): added because
// Ipanema Joias' own live sheet predates these tabs (ERP Fase 1 shipped after
// it was already in use) and this file used to only mirror the ORIGINAL
// columns — but every NEW company created from this template is meant to
// have them from day one, matching companyTemplate_ exactly (same tab names,
// same header words, segment-independent — these three never change wording
// by segment, unlike Lançamento/Estoque). Keep in sync with
// FORNECEDORES_HEADERS/CONTAS_HEADERS in apps-script/Code.gs if either ever
// changes there.
//
// Everything here is static text chosen from a fixed list: no user data goes
// into the file.

// ---------------------------------------------------------------------------
// Minimal zip writer (store, no compression)
// ---------------------------------------------------------------------------

let tabelaCrc = null;

function crc32(bytes) {
  if (!tabelaCrc) {
    tabelaCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabelaCrc[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = tabelaCrc[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// arquivos: [{ nome, texto }] -> Uint8Array of a valid .zip
function criarZip(arquivos) {
  const codificador = new TextEncoder();
  const partes = [];
  const central = [];
  let deslocamento = 0;
  const hora = 0;
  const data = ((2026 - 1980) << 9) | (9 << 5) | 20;
  arquivos.forEach((arq) => {
    const nome = codificador.encode(arq.nome);
    const dados = codificador.encode(arq.texto);
    const crc = crc32(dados);
    const cabecalho = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(hora), ...u16(data),
      ...u32(crc), ...u32(dados.length), ...u32(dados.length), ...u16(nome.length), ...u16(0),
    ]);
    partes.push(cabecalho, nome, dados);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(hora), ...u16(data),
        ...u32(crc), ...u32(dados.length), ...u32(dados.length), ...u16(nome.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(deslocamento),
      ]),
      nome
    );
    deslocamento += cabecalho.length + nome.length + dados.length;
  });
  const tamanhoCentral = central.reduce((soma, p) => soma + p.length, 0);
  const fim = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(arquivos.length), ...u16(arquivos.length),
    ...u32(tamanhoCentral), ...u32(deslocamento), ...u16(0),
  ]);
  const todas = partes.concat(central, [fim]);
  const total = todas.reduce((soma, p) => soma + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  todas.forEach((p) => {
    saida.set(p, pos);
    pos += p.length;
  });
  return saida;
}

// ---------------------------------------------------------------------------
// Headers of each tab, in the words of a segment (same as the server's template)
// ---------------------------------------------------------------------------

function cabecalhosDoModelo(idSegmento) {
  const joia = segmentoValido(idSegmento) === "joalheria";
  const listas = ["Código", "Nome", "Complemento"];
  return {
    lancamento: ["Data", "Loja", "Conta", "Empresa", "Categoria", "Valor", "Tipo", joia ? "Peso (g)" : "Quantidade", "Pessoa", "Observação"],
    estoque: [
      "Produto", "Tipo", "Marca", "Condição", "Estado", joia ? "Peso em grama" : "Quantidade", joia ? "Pureza (k)" : "Especificação",
      "Valor de Custo", "Valor de venda", "Data de Compra", "Data de Venda", "Comprador", "Vendedor", "Loja", "Vendido?", "Observação",
    ],
    // Segment-independent (same wording for every segment), matching
    // FORNECEDORES_HEADERS/CONTAS_HEADERS in apps-script/Code.gs exactly.
    fornecedores: ["Nome", "CNPJ/CPF", "Categoria", "Telefone", "E-mail", "Prazo de pagamento", "Observação", "Status"],
    contasPagar: ["Descrição", "Fornecedor", "Categoria", "Valor", "Vencimento", "Status", "Pago em", "Recorrente", "Observação", "Avisado em"],
    contasReceber: ["Descrição", "Cliente", "Categoria", "Valor", "Vencimento", "Status", "Recebido em", "Recorrente", "Observação", "Avisado em"],
    listas: listas,
    categoria: listas.concat(["Status"]),
  };
}

const LISTAS_DO_MODELO = [
  { aba: "Lojas", ajuda: "As lojas ou unidades da empresa." },
  { aba: "Contas", ajuda: "Onde o dinheiro entra e sai: caixa, banco, cartão..." },
  { aba: "Empresas", ajuda: "O nome da(s) empresa(s) do grupo." },
  { aba: "Categoria", ajuda: "Para classificar cada lançamento: vendas, aluguel, salários..." },
  { aba: "Pessoa", ajuda: "Clientes, fornecedores e funcionários." },
  { aba: "Produto", ajuda: "Os produtos ou itens que a empresa trabalha." },
  { aba: "Tipo de Produto", ajuda: "Grupos de produtos." },
  { aba: "Marcas", ajuda: "As marcas dos produtos." },
];

const LINHAS_PREPARADAS = 1000; // formatted rows below each header
const LINHAS_DAS_LISTAS = 100;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function letraDaColuna(indice) {
  return colunaLetra(indice);
}

function celulaTexto(ref, texto, estilo) {
  return `<c r="${ref}" t="inlineStr"${estilo ? ` s="${estilo}"` : ""}><is><t xml:space="preserve">${escaparXml(texto)}</t></is></c>`;
}

function celulaNumero(ref, numero, estilo) {
  return `<c r="${ref}"${estilo ? ` s="${estilo}"` : ""}><v>${numero}</v></c>`;
}

function celulaFormula(ref, formula, estilo) {
  return `<c r="${ref}"${estilo ? ` s="${estilo}"` : ""}><f>${escaparXml(formula)}</f></c>`;
}

// Style ids (see ESTILOS_XML): 1 header, 2 date column, 3 money column,
// 4 example text, 5 example date, 6 example money, 7 title, 8 body wrap, 9 section.
function planilhaXml(opcoes) {
  const linhas = opcoes.linhas.join("");
  const larguras = opcoes.larguras
    .map((l, i) => `<col min="${i + 1}" max="${i + 1}" width="${l.largura}" customWidth="1"${l.estilo ? ` style="${l.estilo}"` : ""}/>`)
    .join("");
  const congelar = opcoes.congelar
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : "";
  const validacoes = (opcoes.validacoes || []).length
    ? `<dataValidations count="${opcoes.validacoes.length}">${opcoes.validacoes
        .map(
          (v) =>
            `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Valor não permitido" error="Escolha uma das opções da lista." sqref="${v.faixa}"><formula1>"${escaparXml(v.opcoes)}"</formula1></dataValidation>`
        )
        .join("")}</dataValidations>`
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetPr><tabColor rgb="${opcoes.cor || "FFE3B341"}"/></sheetPr>` +
    `<sheetViews><sheetView workbookViewId="0"${opcoes.primeira ? ' tabSelected="1"' : ""}${opcoes.semGrade ? ' showGridLines="0"' : ""}>${congelar}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="18"/>' +
    `<cols>${larguras}</cols>` +
    `<sheetData>${linhas}</sheetData>` +
    validacoes +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    "</worksheet>"
  );
}

const ESTILOS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>' +
  '<fonts count="5">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FF1A1400"/><name val="Calibri"/></font>' +
  '<font><i/><sz val="11"/><color rgb="FF6B6558"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="16"/><color rgb="FF1A1400"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="12"/><color rgb="FF1A1400"/><name val="Calibri"/></font>' +
  "</fonts>" +
  '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE3B341"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F0E8"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFBF1D5"/><bgColor indexed="64"/></patternFill></fill>' +
  "</fills>" +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFB58B0B"/></left><right style="thin"><color rgb="FFB58B0B"/></right><top style="thin"><color rgb="FFB58B0B"/></top><bottom style="thin"><color rgb="FFB58B0B"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="10">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="165" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="4" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function serialModelo(ano, mes, dia) {
  return Math.round((Date.UTC(ano, mes - 1, dia) - Date.UTC(1899, 11, 30)) / 86400000);
}

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

function abaInstrucoes(idSegmento) {
  const seg = getSegmento(idSegmento);
  const qtd = segmentoValido(idSegmento) === "joalheria" ? "Peso (g)" : "Quantidade";
  const linhas = [];
  let n = 1;
  const texto = (t, estilo, altura) => {
    linhas.push(`<row r="${n}"${altura ? ` ht="${altura}" customHeight="1"` : ""}>${celulaTexto(`A${n}`, t, estilo)}</row>`);
    n += 1;
  };
  const vazia = () => {
    n += 1;
  };
  texto(`Modelo de planilha — ${seg.nome}`, 7, 30);
  texto("Feito para você começar do zero, sem precisar entender de planilhas.", 8);
  vazia();
  texto("COMO PREENCHER (passo a passo)", 9, 24);
  texto("1. Não apague nem mude os títulos da primeira linha de cada aba (Data, Valor, Tipo...). É por eles que o Finan. entende cada coluna.", 8, 34);
  texto("2. Aba \"Lançamento\": uma linha para cada entrada ou saída de dinheiro. Preencha da esquerda para a direita.", 8, 34);
  texto("3. Aba \"Estoque\": uma linha para cada item que a empresa tem para vender.", 8, 20);
  texto("4. Abas \"Fornecedores\", \"Contas a Pagar\" e \"Contas a Receber\": opcionais, para controlar fornecedores e contas do financeiro. Pode deixar vazias se não for usar agora.", 8, 34);
  texto("5. Abas de listas (Lojas, Contas, Categoria, Pessoa...): digite só o NOME, um por linha. O código e o \"código - nome\" aparecem sozinhos.", 8, 34);
  texto("6. Veja a aba \"Exemplo\": ela mostra linhas já preenchidas. As abas de verdade começam vazias.", 8, 34);
  vazia();
  texto("REGRAS PARA NÃO ERRAR", 9, 24);
  texto("• Data: no formato dia/mês/ano, por exemplo 05/09/2026.", 8);
  texto("• Valor: sempre um número positivo, sem \"R$\". Quem diz se o dinheiro entrou ou saiu é a coluna Tipo.", 8, 34);
  texto("• Tipo: escolha na listinha: Entrada (dinheiro que entrou) ou Saída (dinheiro que saiu).", 8, 34);
  texto(`• ${qtd}: opcional. Use se controla quantidades${segmentoValido(idSegmento) === "joalheria" ? " ou gramas" : ""} nas compras e vendas.`, 8, 34);
  texto("• Vendido?: na aba Estoque, escolha Sim ou Não. Deixe Não enquanto o item estiver na loja.", 8, 34);
  texto("• Não deixe linhas em branco no meio dos dados.", 8);
  texto("• Pode acrescentar colunas suas depois da última (ex.: \"Nº da nota\"). O app mostra as colunas extras também.", 8, 34);
  vazia();
  texto("O QUE COLOCAR EM CADA COLUNA — LANÇAMENTO", 9, 24);
  [
    ["Data", "O dia em que aconteceu."],
    ["Loja", "Em qual loja ou unidade (opcional)."],
    ["Conta", "Caixa, banco, cartão..."],
    ["Empresa", "O nome da empresa."],
    ["Categoria", "Vendas, aluguel, salários... Serve para os gráficos."],
    ["Valor", "Quanto foi, sempre positivo."],
    ["Tipo", "Entrada ou Saída."],
    [qtd, "Opcional: quantidade envolvida."],
    ["Pessoa", "Cliente, fornecedor ou funcionário."],
    ["Observação", "Qualquer anotação."],
  ].forEach(([col, ajuda]) => texto(`${col}: ${ajuda}`, 8));
  vazia();
  texto("O QUE COLOCAR EM CADA COLUNA — ESTOQUE", 9, 24);
  const est = cabecalhosDoModelo(idSegmento).estoque;
  [
    [est[0], "O nome do item."], [est[1], "O tipo ou grupo do item."], [est[2], "A marca."], [est[3], "Novo, seminovo, excelente..."],
    [est[4], "Ex.: venda direta, consignado."], [est[5], "Quanto tem (opcional)."], [est[6], "Detalhe extra: tamanho, modelo, cor... (opcional)."],
    [est[7], "Quanto custou."], [est[8], "Por quanto foi vendido (preencha ao vender)."], [est[9], "Quando entrou no estoque."],
    [est[10], "Quando foi vendido (preencha ao vender)."], [est[11], "Quem comprou."], [est[12], "Quem vendeu."], [est[13], "Onde está."],
    [est[14], "Sim ou Não."], [est[15], "Qualquer anotação."],
  ].forEach(([col, ajuda]) => texto(`${col}: ${ajuda}`, 8));
  vazia();
  texto("O QUE COLOCAR EM CADA COLUNA — FORNECEDORES", 9, 24);
  [
    ["Nome", "O nome do fornecedor."],
    ["CNPJ/CPF", "Opcional."],
    ["Categoria", "Para organizar: matéria-prima, serviços..."],
    ["Telefone", "Opcional."],
    ["E-mail", "Opcional."],
    ["Prazo de pagamento", "Ex.: 30 dias (texto livre)."],
    ["Observação", "Qualquer anotação."],
    ["Status", "Ativo ou Inativo. Deixe Ativo enquanto usar este fornecedor."],
  ].forEach(([col, ajuda]) => texto(`${col}: ${ajuda}`, 8, 20));
  vazia();
  texto("O QUE COLOCAR EM CADA COLUNA — CONTAS A PAGAR / CONTAS A RECEBER", 9, 24);
  texto("As duas abas têm o mesmo formato; só muda \"Fornecedor\" (a pagar) por \"Cliente\" (a receber).", 8, 20);
  [
    ["Descrição", "O que é a conta, ex.: \"Contador\", \"Aluguel\"."],
    ["Fornecedor / Cliente", "Quem vai receber ou pagar."],
    ["Categoria", "Para organizar, igual ao Lançamento."],
    ["Valor", "Sempre positivo, sem \"R$\"."],
    ["Vencimento", "Data em que vence, dia/mês/ano."],
    ["Status", "Pendente, Pago/Recebido ou Cancelada."],
    ["Pago em / Recebido em", "Deixe em branco — o Finan. preenche sozinho quando a conta é paga/recebida pelo app."],
    ["Recorrente", "Sim ou Não. Sim repete automaticamente todo mês depois de paga/recebida."],
    ["Observação", "Qualquer anotação."],
    ["Avisado em", "Deixe em branco — uso interno do Finan. para não repetir avisos por e-mail."],
  ].forEach(([col, ajuda]) => texto(`${col}: ${ajuda}`, 8, 20));
  vazia();
  texto("DEPOIS DE PREENCHER", 9, 24);
  texto("Este arquivo tem exatamente as abas e colunas que o Finan. usa. Você pode preencher aqui (no Excel, no Google Planilhas ou no Numbers) e depois copiar e colar as linhas na planilha da sua empresa, mantendo a mesma ordem das colunas.", 8, 50);
  texto("Se a sua empresa ainda não tem uma planilha no Finan., peça ao administrador do sistema: ele cria uma já com esta estrutura.", 8, 34);
  return planilhaXml({ linhas, larguras: [{ largura: 110 }], primeira: true, semGrade: true, cor: "FF1A1400" });
}

function abaDeDados(cabecalho, opcoes) {
  const linhaCab = `<row r="1" ht="30" customHeight="1">${cabecalho.map((t, i) => celulaTexto(`${letraDaColuna(i)}1`, t, 1)).join("")}</row>`;
  const larguras = cabecalho.map((t, i) => {
    let estilo = 0;
    if (opcoes.datas.indexOf(i) !== -1) estilo = 2;
    if (opcoes.dinheiro.indexOf(i) !== -1) estilo = 3;
    return { largura: Math.max(14, Math.min(34, t.length + 8)), estilo: estilo };
  });
  if (opcoes.largas) opcoes.largas.forEach((i) => (larguras[i].largura = 30));
  return planilhaXml({ linhas: [linhaCab], larguras, congelar: true, validacoes: opcoes.validacoes });
}

function abaDeLista(cabecalho, ehCategoria) {
  const linhas = [`<row r="1" ht="26" customHeight="1">${cabecalho.map((t, i) => celulaTexto(`${letraDaColuna(i)}1`, t, 1)).join("")}</row>`];
  for (let r = 2; r <= LINHAS_DAS_LISTAS + 1; r += 1) {
    const celulas = [celulaFormula(`A${r}`, `IF(B${r}="","",ROW()-1)`), `<c r="B${r}"/>`, celulaFormula(`C${r}`, `IF(B${r}="","",A${r}&" - "&B${r})`)];
    if (ehCategoria) celulas.push(celulaFormula(`D${r}`, `IF(B${r}="","","Ativo")`));
    linhas.push(`<row r="${r}">${celulas.join("")}</row>`);
  }
  const larguras = cabecalho.map((t, i) => ({ largura: i === 1 ? 34 : i === 2 ? 38 : 14 }));
  return planilhaXml({ linhas, larguras, congelar: true, cor: "FF6B6558" });
}

function abaExemplo(idSegmento) {
  const cab = cabecalhosDoModelo(idSegmento);
  const linhas = [];
  let n = 1;
  const titulo = (t) => {
    linhas.push(`<row r="${n}" ht="26" customHeight="1">${celulaTexto(`A${n}`, t, 9)}</row>`);
    n += 1;
  };
  const cabecalho = (lista) => {
    linhas.push(`<row r="${n}" ht="30" customHeight="1">${lista.map((t, i) => celulaTexto(`${letraDaColuna(i)}${n}`, t, 1)).join("")}</row>`);
    n += 1;
  };
  const dados = (lista, tipos) => {
    linhas.push(
      `<row r="${n}">${lista
        .map((v, i) => {
          const ref = `${letraDaColuna(i)}${n}`;
          if (v === "" || v === null) return `<c r="${ref}" s="4"/>`;
          if (typeof v === "number") return celulaNumero(ref, v, tipos[i] === "d" ? 5 : tipos[i] === "m" ? 6 : 4);
          return celulaTexto(ref, v, 4);
        })
        .join("")}</row>`
    );
    n += 1;
  };
  const joia = segmentoValido(idSegmento) === "joalheria";
  titulo("EXEMPLO — aba Lançamento (só para inspirar; não copie estas linhas)");
  cabecalho(cab.lancamento);
  const tl = ["d", "", "", "", "", "m", "", "", "", ""];
  dados([serialModelo(2026, 9, 1), "Loja Centro", "Caixa", "Minha Empresa", "Vendas", 1500, "Entrada", joia ? 12.5 : 3, "Maria", "Venda no balcão"], tl);
  dados([serialModelo(2026, 9, 2), "Loja Centro", "Banco", "Minha Empresa", "Aluguel", 2800, "Saída", "", "Imobiliária", "Aluguel de setembro"], tl);
  dados([serialModelo(2026, 9, 3), "Loja Norte", "Caixa", "Minha Empresa", "Compras", 640.5, "Saída", joia ? 8 : 10, "Fornecedor A", ""], tl);
  n += 1;
  titulo("EXEMPLO — aba Estoque");
  cabecalho(cab.estoque);
  const te = ["", "", "", "", "", "", "", "m", "m", "d", "d", "", "", "", "", ""];
  dados(["Item de exemplo 1", "Grupo A", "Marca X", "Novo", "Venda direta", joia ? 4.2 : 10, joia ? 18 : "Tamanho M", 320, "", serialModelo(2026, 8, 3), "", "", "", "Loja Centro", "Não", ""], te);
  dados(["Item de exemplo 2", "Grupo B", "Marca Y", "Seminovo", "Consignado", joia ? 9.5 : 4, joia ? "" : "Cor azul", 510, 700, serialModelo(2026, 7, 1), serialModelo(2026, 9, 2), "Carlos", "Ana", "Loja Norte", "Sim", "Vendido no crediário"], te);
  n += 1;
  titulo("EXEMPLO — aba Fornecedores");
  cabecalho(cab.fornecedores);
  dados(["Fornecedor de exemplo", "12.345.678/0001-90", "Matéria-prima", "(21) 99999-0000", "contato@exemplo.com", "30 dias", "", "Ativo"], []);
  n += 1;
  titulo("EXEMPLO — aba Contas a Pagar (deixe \"Pago em\" e \"Avisado em\" em branco: o Finan. preenche sozinho)");
  cabecalho(cab.contasPagar);
  const tcp = ["", "", "", "m", "d", "", "d", "", "", "d"];
  dados(["Contador", "Fornecedor de exemplo", "Serviços", 450, serialModelo(2026, 10, 30), "Pendente", "", "Sim", "", ""], tcp);
  n += 1;
  titulo("EXEMPLO — aba Contas a Receber (deixe \"Recebido em\" e \"Avisado em\" em branco: o Finan. preenche sozinho)");
  cabecalho(cab.contasReceber);
  dados(["Venda a prazo", "Cliente de exemplo", "Vendas", 1200, serialModelo(2026, 11, 5), "Pendente", "", "Não", "", ""], tcp);
  return planilhaXml({ linhas, larguras: cab.estoque.map(() => ({ largura: 18 })), cor: "FF6B6558" });
}

// ---------------------------------------------------------------------------
// The whole workbook
// ---------------------------------------------------------------------------

function gerarModeloXlsx(idSegmento) {
  const id = segmentoValido(idSegmento);
  const cab = cabecalhosDoModelo(id);
  const abas = [
    { nome: "Instruções", xml: abaInstrucoes(id) },
    {
      nome: "Lançamento",
      xml: abaDeDados(cab.lancamento, {
        datas: [0],
        dinheiro: [5],
        largas: [9],
        validacoes: [{ faixa: `G2:G${LINHAS_PREPARADAS}`, opcoes: "Entrada,Saída" }],
      }),
    },
    {
      nome: "Estoque",
      xml: abaDeDados(cab.estoque, {
        datas: [9, 10],
        dinheiro: [7, 8],
        largas: [0, 15],
        validacoes: [{ faixa: `O2:O${LINHAS_PREPARADAS}`, opcoes: "Sim,Não" }],
      }),
    },
    {
      nome: "Fornecedores",
      xml: abaDeDados(cab.fornecedores, {
        datas: [],
        dinheiro: [],
        largas: [6],
        validacoes: [{ faixa: `H2:H${LINHAS_PREPARADAS}`, opcoes: "Ativo,Inativo" }],
      }),
    },
    {
      nome: "Contas a Pagar",
      xml: abaDeDados(cab.contasPagar, {
        datas: [4, 6, 9],
        dinheiro: [3],
        largas: [8],
        validacoes: [
          { faixa: `F2:F${LINHAS_PREPARADAS}`, opcoes: "Pendente,Pago,Cancelada" },
          { faixa: `H2:H${LINHAS_PREPARADAS}`, opcoes: "Sim,Não" },
        ],
      }),
    },
    {
      nome: "Contas a Receber",
      xml: abaDeDados(cab.contasReceber, {
        datas: [4, 6, 9],
        dinheiro: [3],
        largas: [8],
        validacoes: [
          { faixa: `F2:F${LINHAS_PREPARADAS}`, opcoes: "Pendente,Recebido,Cancelada" },
          { faixa: `H2:H${LINHAS_PREPARADAS}`, opcoes: "Sim,Não" },
        ],
      }),
    },
  ];
  LISTAS_DO_MODELO.forEach((lista) => abas.push({ nome: lista.aba, xml: abaDeLista(lista.aba === "Categoria" ? cab.categoria : cab.listas, lista.aba === "Categoria") }));
  abas.push({ nome: "Exemplo", xml: abaExemplo(id) });

  const arquivos = [
    {
      nome: "[Content_Types].xml",
      texto:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        abas.map((a, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>",
    },
    {
      nome: "_rels/.rels",
      texto:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      nome: "xl/workbook.xml",
      texto:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>' +
        "<sheets>" +
        abas.map((a, i) => `<sheet name="${escaparXml(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets>" +
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    },
    {
      nome: "xl/_rels/workbook.xml.rels",
      texto:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        abas.map((a, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { nome: "xl/styles.xml", texto: ESTILOS_XML },
  ];
  abas.forEach((a, i) => arquivos.push({ nome: `xl/worksheets/sheet${i + 1}.xml`, texto: a.xml }));
  return criarZip(arquivos);
}

function nomeDoArquivoModelo(idSegmento) {
  const id = segmentoValido(idSegmento);
  return `modelo-planilha-${id}.xlsx`;
}

function baixarModelo(idSegmento) {
  const bytes = gerarModeloXlsx(idSegmento);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeDoArquivoModelo(idSegmento);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
