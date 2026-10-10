const COMMANDS = [
  { view: "dashboard", label: "Dashboard", group: "Navegação" },
  { view: "lancamento-lista", label: "Consultar lançamentos", group: "Fluxo de Caixa" },
  { view: "lancamento-form", label: "Novo lançamento", group: "Fluxo de Caixa" },
  { view: "estoque-lista", label: "Consultar estoque", group: "Estoque" },
  { view: "estoque-form", labelKey: "novoItem", label: "Novo item", group: "Estoque" },
  { view: "fornecedores-lista", label: "Consultar fornecedores", group: "Compras" },
  { view: "fornecedores-form", label: "Novo fornecedor", group: "Compras" },
  { view: "contas-pagar-lista", label: "Contas a Pagar", group: "Financeiro" },
  { view: "contas-pagar-form", label: "Nova conta a pagar", group: "Financeiro" },
  { view: "contas-receber-lista", label: "Contas a Receber", group: "Financeiro" },
  { view: "contas-receber-form", label: "Nova conta a receber", group: "Financeiro" },
  { view: "relatorio", label: "Relatório", group: "Financeiro" },
  { view: "ajustes", label: "Ajustes", group: "Navegação" },
];

function commandLabel(cmd) {
  return cmd.labelKey ? vocab(cmd.labelKey) : cmd.label;
}

let paletteSelectedIndex = 0;
let paletteFiltered = [];

// A command is only offered if its nav element actually exists and isn't
// role-hidden right now (mirrors applyRoleVisibility in js/nav.js) — the
// palette must never offer a shortcut to something the current role
// shouldn't see just because it skips the sidebar.
function isCommandAvailable(cmd) {
  const el = document.querySelector(`.nav-item[data-view="${cmd.view}"]`);
  return Boolean(el) && !el.hidden;
}

function renderCommandResults(query) {
  const normalized = query.trim().toLowerCase();
  paletteFiltered = COMMANDS.filter(isCommandAvailable).filter(
    (cmd) => !normalized || commandLabel(cmd).toLowerCase().includes(normalized) || cmd.group.toLowerCase().includes(normalized)
  );
  paletteSelectedIndex = 0;

  const container = document.getElementById("command-palette-results");
  container.innerHTML = "";

  if (paletteFiltered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "Nada encontrado.";
    container.appendChild(empty);
    return;
  }

  paletteFiltered.forEach((cmd, index) => {
    const item = document.createElement("div");
    item.className = `command-palette-item${index === paletteSelectedIndex ? " active" : ""}`;

    const label = document.createElement("span");
    label.textContent = commandLabel(cmd);

    const group = document.createElement("span");
    group.className = "command-palette-group";
    group.textContent = cmd.group;

    item.appendChild(label);
    item.appendChild(group);
    item.addEventListener("click", () => selectCommand(cmd));
    container.appendChild(item);
  });
}

function selectCommand(cmd) {
  setActiveView(cmd.view);
  closeCommandPalette();
}

function highlightPaletteIndex(newIndex) {
  const items = document.querySelectorAll(".command-palette-item");
  if (items.length === 0) return;
  paletteSelectedIndex = (newIndex + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle("active", i === paletteSelectedIndex));
  items[paletteSelectedIndex].scrollIntoView({ block: "nearest" });
}

function openCommandPalette() {
  const overlay = document.getElementById("command-palette");
  const input = document.getElementById("command-palette-input");
  overlay.hidden = false;
  input.value = "";
  renderCommandResults("");
  input.focus();
}

function closeCommandPalette() {
  document.getElementById("command-palette").hidden = true;
}

let commandPaletteInitialized = false;

function setupCommandPalette() {
  if (commandPaletteInitialized) return;
  commandPaletteInitialized = true;

  const trigger = document.getElementById("command-bar-trigger");
  const overlay = document.getElementById("command-palette");
  const input = document.getElementById("command-palette-input");

  trigger.addEventListener("click", openCommandPalette);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeCommandPalette();
  });

  input.addEventListener("input", () => renderCommandResults(input.value));

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCommandPalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightPaletteIndex(paletteSelectedIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightPaletteIndex(paletteSelectedIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (paletteFiltered[paletteSelectedIndex]) selectCommand(paletteFiltered[paletteSelectedIndex]);
    }
  });

  document.addEventListener("keydown", (event) => {
    const isK = event.key === "k" || event.key === "K";
    if (!(event.metaKey || event.ctrlKey) || !isK) return;
    // Only inside the logged-in app — never hijack the shortcut on auth screens.
    if (document.getElementById("app-shell").hidden) return;
    event.preventDefault();
    if (overlay.hidden) openCommandPalette();
    else closeCommandPalette();
  });
}
