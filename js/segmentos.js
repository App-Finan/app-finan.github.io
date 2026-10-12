// Business segments. The product is "Finan." (segment-neutral); each company
// belongs to one segment, which picks the brand shown inside the app
// (Joalheria -> FinanGold, Petshop -> FinanPet...) and the vocabulary of the
// screens. Only WORDS change per segment: the spreadsheet columns are never
// renamed here (companies may not own their sheets), see js/esquema.js.

const SEGMENTO_PADRAO = "joalheria";

// Words for a company whose segment has nothing specific about them.
const VOCAB_GERAL = {
  item: "item",
  itens: "itens",
  novoItem: "Novo item",
  salvarItem: "Salvar item",
  nenhumItem: "Nenhum item encontrado.",
  confirmarRetorno: "Confirmar retorno deste item à loja?",
  itemSalvo: "Item salvo na linha",
  carregados: "itens carregados",
  qtdRotulo: "Quantidade",
  qtdNome: "Quantidade",
  qtdMinuscula: "a quantidade",
  qtdUnidade: "un",
  espRotulo: "Especificação",
  espNumerica: false,
  kpiCompra: "Compras",
  kpiCompraExtra: " de itens",
  kpiVenda: "Vendas",
  kpiVendaExtra: " de itens",
  kpiQuantidade: "seTiver",
};

const SEGMENTOS = {
  joalheria: {
    nome: "Joalheria",
    marca: "FinanGold",
    vocab: {
      item: "peça",
      itens: "peças",
      novoItem: "Nova peça",
      salvarItem: "Salvar peça",
      nenhumItem: "Nenhuma peça encontrada.",
      confirmarRetorno: "Confirmar retorno desta peça à loja?",
      itemSalvo: "Peça salva na linha",
      carregados: "peças carregados",
      qtdRotulo: "Peso (g)",
      qtdNome: "Peso",
      qtdMinuscula: "o peso",
      qtdUnidade: "g",
      espRotulo: "Pureza (k)",
      espNumerica: true,
      kpiCompraExtra: " de ouro (g)",
      kpiVendaExtra: " de ouro (g)",
      kpiQuantidade: "sempre",
    },
  },
  petshop: { nome: "Petshop", marca: "FinanPet", vocab: {} },
  comercio: { nome: "Comércio em geral", marca: "FinanShop", vocab: {} },
  servicos: { nome: "Serviços", marca: "FinanServ", vocab: {} },
  alimentacao: { nome: "Alimentação", marca: "FinanFood", vocab: {} },
  saude: { nome: "Saúde e bem-estar", marca: "FinanCare", vocab: {} },
  outro: { nome: "Outro segmento", marca: "Finan.", vocab: {} },
};

let segmentoAtual = SEGMENTO_PADRAO;

function segmentoValido(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(SEGMENTOS, id) ? id : SEGMENTO_PADRAO;
}

function getSegmento(id) {
  return SEGMENTOS[segmentoValido(id === undefined ? segmentoAtual : id)];
}

// vocab("item") -> the word for the current company's segment.
function vocab(chave) {
  const seg = getSegmento();
  return seg.vocab[chave] !== undefined ? seg.vocab[chave] : VOCAB_GERAL[chave];
}

function formatQuantidade(valor) {
  if (typeof valor !== "number") return "";
  if (vocab("qtdUnidade") === "g") return formatGrams(valor);
  return `${valor.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${vocab("qtdUnidade")}`;
}

// Every segment's marca starts with the literal "Finan" (FinanGold,
// FinanPet, FinanShop...) — splits it there and colors the rest gold
// (.wordmark-capital, the same class/token "Capital" uses in "Finan.
// Capital" elsewhere), via createElement/textContent, not innerHTML.
// "Finan." (Outro, no suffix) just renders as plain text, unsplit.
function renderMarcaTitulo(el, marca) {
  el.textContent = "";
  if (typeof marca === "string" && marca.length > 5 && marca.slice(0, 5) === "Finan") {
    el.appendChild(document.createTextNode(marca.slice(0, 5)));
    const resto = document.createElement("span");
    resto.className = "wordmark-capital";
    resto.textContent = marca.slice(5);
    el.appendChild(resto);
  } else {
    el.textContent = marca;
  }
}

// Switches the whole interface to a segment: brand, caption and every element
// marked data-vocab="chave" (its text becomes vocab(chave)).
function aplicarSegmento(id) {
  segmentoAtual = segmentoValido(id);
  const seg = getSegmento();
  document.querySelectorAll("[data-vocab]").forEach((el) => {
    el.textContent = vocab(el.dataset.vocab);
  });
  const title = document.getElementById("sidebar-title");
  if (title) renderMarcaTitulo(title, seg.marca);
  if (typeof trocarLogoSegmento === "function") trocarLogoSegmento(segmentoAtual);
  const espInput = document.getElementById("estoque-field-pureza");
  if (espInput) {
    espInput.type = vocab("espNumerica") ? "number" : "text";
    espInput.placeholder = vocab("espNumerica") ? "" : "Ex: tamanho, modelo, cor";
  }
}
