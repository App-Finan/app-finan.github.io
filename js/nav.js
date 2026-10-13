const VIEW_TITLES = {
  dashboard: "Dashboard financeiro",
  "lancamento-lista": "Fluxo de Caixa",
  "lancamento-form": "Novo lançamento",
  "estoque-lista": "Estoque",
  "fornecedores-lista": "Fornecedores",
  "fornecedores-form": "Novo fornecedor",
  "contas-pagar-lista": "Contas a Pagar",
  "contas-pagar-form": "Nova conta a pagar",
  "contas-receber-lista": "Contas a Receber",
  "contas-receber-form": "Nova conta a receber",
  relatorio: "Relatório",
  ajustes: "Ajustes",
};

function getViewTitle(view) {
  if (view === "estoque-form") return vocab("novoItem");
  return VIEW_TITLES[view] || "";
}

const VIEW_EYEBROWS = {
  dashboard: "Painel",
  "lancamento-lista": "Fluxo de caixa",
  "lancamento-form": "Fluxo de caixa",
  "estoque-lista": "Estoque",
  "estoque-form": "Estoque",
  "fornecedores-lista": "Compras",
  "fornecedores-form": "Compras",
  "contas-pagar-lista": "Financeiro",
  "contas-pagar-form": "Financeiro",
  "contas-receber-lista": "Financeiro",
  "contas-receber-form": "Financeiro",
  relatorio: "Financeiro",
  ajustes: "Ajustes",
};

// Only "financeiro" still has a submenu (Fluxo de Caixa/Estoque/Compras became
// flat nav items — see index.html — to cut down the menu; their "Novo ..."
// forms are reached from a button on the listing screen instead, not from the
// sidebar at all, so they have no group to keep open/highlighted here).
const VIEW_GROUPS = {
  "contas-pagar-lista": "financeiro",
  "contas-pagar-form": "financeiro",
  "contas-receber-lista": "financeiro",
  "contas-receber-form": "financeiro",
  relatorio: "financeiro",
};

const SIDEBAR_COLLAPSED_KEY = "financegold_sidebar_collapsed";
const LAST_VIEW_KEY = "financegold_view";
let lastViewRestored = false;

// After a page reload, go back to the screen the user was on instead of always
// the dashboard. Only once per page load (switching company later should start
// fresh), and only if the role can still see that screen.
function restoreLastViewOnce() {
  if (lastViewRestored) return;
  lastViewRestored = true;
  try {
    const view = sessionStorage.getItem(LAST_VIEW_KEY);
    if (!view) return;
    const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navItem && !navItem.hidden) setActiveView(view);
  } catch (err) {
    // convenience only
  }
}

function setActiveView(view) {
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".nav-group-toggle").forEach((btn) => {
    btn.classList.toggle("active", VIEW_GROUPS[view] === btn.dataset.group);
  });
  document.querySelectorAll(".view-section").forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
  const topbarTitle = document.querySelector(".app-topbar h2");
  if (topbarTitle) topbarTitle.textContent = getViewTitle(view);
  const topbarEyebrow = document.getElementById("topbar-eyebrow");
  if (topbarEyebrow) topbarEyebrow.textContent = VIEW_EYEBROWS[view] || "";

  const group = VIEW_GROUPS[view];
  if (group) openSubmenu(group);

  try {
    sessionStorage.setItem(LAST_VIEW_KEY, view);
  } catch (err) {
    // convenience only
  }
}

function openSubmenu(group) {
  const submenu = document.getElementById(`submenu-${group}`);
  if (submenu) submenu.hidden = false;
  const toggle = document.querySelector(`.nav-group-toggle[data-group="${group}"]`);
  if (toggle) toggle.classList.add("expanded");
}

function toggleSubmenu(group) {
  const submenu = document.getElementById(`submenu-${group}`);
  const toggle = document.querySelector(`.nav-group-toggle[data-group="${group}"]`);
  const willOpen = submenu.hidden;
  submenu.hidden = !willOpen;
  if (toggle) toggle.classList.toggle("expanded", willOpen);
}

function loadSidebarCollapsedPref() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch (err) {
    return false;
  }
}

function saveSidebarCollapsedPref(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch (err) {
    // per-browser convenience only — ignore if storage is unavailable
  }
}

function applySidebarCollapsed(collapsed) {
  const sidebar = document.getElementById("sidebar");
  const btn = document.getElementById("sidebar-collapse-btn");
  sidebar.classList.toggle("collapsed", collapsed);
  btn.textContent = collapsed ? "›" : "‹";
  btn.title = collapsed ? "Expandir menu" : "Minimizar menu";
  btn.setAttribute("aria-label", btn.title);
}

// Off-canvas drawer on mobile (see the @media (max-width: 860px) block in
// css/style.css) — toggled by #sidebar-mobile-toggle, closed by tapping the
// backdrop or picking a nav item. Toggling ".mobile-open" has no effect
// outside that breakpoint, so this is safe to call unconditionally.
function setSidebarMobileOpen(open) {
  document.getElementById("sidebar").classList.toggle("mobile-open", open);
  document.getElementById("sidebar-backdrop").hidden = !open;
}

function setupSidebarMobileDrawer() {
  document.getElementById("sidebar-mobile-toggle").addEventListener("click", () => {
    setSidebarMobileOpen(true);
  });
  document.getElementById("sidebar-backdrop").addEventListener("click", () => {
    setSidebarMobileOpen(false);
  });
}

function setupSidebarCollapse() {
  applySidebarCollapsed(loadSidebarCollapsedPref());

  document.getElementById("sidebar-collapse-btn").addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    const collapsed = !sidebar.classList.contains("collapsed");
    applySidebarCollapsed(collapsed);
    saveSidebarCollapsedPref(collapsed);
  });
}

// Purely a UI convenience — hides screens a role shouldn't casually use.
// Not a security boundary (see js/roles.js). These "Novo ..." buttons live on
// each listing screen now (not the sidebar — see index.html), so this just
// hides the buttons themselves instead of nav-subitems.
function applyRoleVisibility(role) {
  const editable = canEdit(role);
  ["btn-novo-lancamento", "btn-novo-estoque", "btn-novo-fornecedor", "btn-nova-conta-pagar", "btn-nova-conta-receber"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.hidden = !editable;
  });
}

let navigationInitialized = false;

function setupNavigation() {
  if (navigationInitialized) return;
  navigationInitialized = true;

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveView(btn.dataset.view);
      setSidebarMobileOpen(false);
    });
  });
  document.querySelectorAll(".nav-group-toggle").forEach((btn) => {
    btn.addEventListener("click", () => toggleSubmenu(btn.dataset.group));
  });
  // "Novo ..." (on each listing screen) and "Cancelar" (on each form) — a
  // plain view switch, same idea as .activity-see-all on the dashboard, just
  // shared across every one of these buttons instead of a one-off handler per button.
  document.querySelectorAll(".btn-ir-tela[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view));
  });

  setupSidebarCollapse();
  setupSidebarMobileDrawer();
  setupCommandPalette();
}
