// Business segments. The product is "Finan. Capital" — one single identity,
// shown the same way to every company regardless of segment (per-segment
// brand names like "FinanGold"/"FinanPet" were removed 2026-10-12, on
// request). Each company still belongs to one segment, which now only picks
// the VOCABULARY of its screens ("peça" vs "item", etc.) — nothing visual.
// The spreadsheet columns are never renamed here (companies may not own
// their sheets), see js/esquema.js.

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
  petshop: { nome: "Petshop", vocab: {} },
  comercio: { nome: "Comércio em geral", vocab: {} },
  servicos: { nome: "Serviços", vocab: {} },
  alimentacao: { nome: "Alimentação", vocab: {} },
  saude: { nome: "Saúde e bem-estar", vocab: {} },
  outro: { nome: "Outro segmento", vocab: {} },
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

// The sidebar always shows the one real brand, "Finan. Capital" — "Finan."
// ink-colored, "Capital" gold (.wordmark-capital, the same class the login
// wordmark uses), via createElement/textContent, not innerHTML. Segment-
// specific brand names (FinanGold, FinanPet...) were removed 2026-10-12.
function renderMarcaTitulo(el) {
  el.textContent = "";
  el.appendChild(document.createTextNode("Finan. "));
  const capital = document.createElement("span");
  capital.className = "wordmark-capital";
  capital.textContent = "Capital";
  el.appendChild(capital);
}

// Switches the whole interface to a segment: vocabulary (every element
// marked data-vocab="chave" becomes vocab(chave)) — the brand itself (name,
// logo) no longer varies by segment, only the words on screen do.
function aplicarSegmento(id) {
  segmentoAtual = segmentoValido(id);
  document.querySelectorAll("[data-vocab]").forEach((el) => {
    el.textContent = vocab(el.dataset.vocab);
  });
  const title = document.getElementById("sidebar-title");
  if (title) renderMarcaTitulo(title);
  if (typeof trocarLogoSegmento === "function") trocarLogoSegmento();
  const espInput = document.getElementById("estoque-field-pureza");
  if (espInput) {
    espInput.type = vocab("espNumerica") ? "number" : "text";
    espInput.placeholder = vocab("espNumerica") ? "" : "Ex: tamanho, modelo, cor";
  }
}
