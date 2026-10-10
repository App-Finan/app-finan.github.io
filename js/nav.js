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
  dashboard: "// painel",
  "lancamento-lista": "// fluxo de caixa",
  "lancamento-form": "// fluxo de caixa",
  "estoque-lista": "// estoque",
  "estoque-form": "// estoque",
  "fornecedores-lista": "// compras",
  "fornecedores-form": "// compras",
  "contas-pagar-lista": "// financeiro",
  "contas-pagar-form": "// financeiro",
  "contas-receber-lista": "// financeiro",
  "contas-receber-form": "// financeiro",
  relatorio: "// financeiro",
  ajustes: "// ajustes",
};

const VIEW_GROUPS = {
  "lancamento-lista": "lancamento",
  "lancamento-form": "lancamento",
  "estoque-lista": "estoque",
  "estoque-form": "estoque",
  "fornecedores-lista": "compras",
  "fornecedores-form": "compras",
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

// Light/dark toggle (direction "Papel", approved 2026-09-26). Applies to the
// whole document (css/style.css's [data-theme="light"] block), but the
// auth-only screens are re-pinned to dark there regardless — #app-shell and
// #sistema-screen are the only screens that actually change look. The
// attribute itself is already set as early as possible, before this runs
// (see js/inicio.js, in <head>), so there is no flash when #app-shell first
// becomes visible; this only needs to sync the button and wire the click.
const THEME_KEY = "financegold_theme";

function loadThemePref() {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch (err) {
    return "dark";
  }
}

function saveThemePref(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    // per-browser convenience only — ignore if storage is unavailable
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  const offerLight = theme !== "light";
  btn.title = offerLight ? "Mudar para modo claro" : "Mudar para modo escuro";
  btn.setAttribute("aria-label", btn.title);
  const sun = btn.querySelector(".icon-theme-sun");
  const moon = btn.querySelector(".icon-theme-moon");
  if (sun) sun.hidden = !offerLight;
  if (moon) moon.hidden = offerLight;
}

function setupThemeToggle() {
  applyTheme(loadThemePref());
  document.getElementById("theme-toggle-btn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    saveThemePref(next);
  });
}

// Purely a UI convenience — hides screens a role shouldn't casually use.
// Not a security boundary (see js/roles.js).
function applyRoleVisibility(role) {
  const editable = canEdit(role);
  const lancForm = document.querySelector('.nav-subitem[data-view="lancamento-form"]');
  const estoqueForm = document.querySelector('.nav-subitem[data-view="estoque-form"]');
  const fornecedoresForm = document.querySelector('.nav-subitem[data-view="fornecedores-form"]');
  const contasPagarForm = document.querySelector('.nav-subitem[data-view="contas-pagar-form"]');
  const contasReceberForm = document.querySelector('.nav-subitem[data-view="contas-receber-form"]');
  if (lancForm) lancForm.hidden = !editable;
  if (estoqueForm) estoqueForm.hidden = !editable;
  if (fornecedoresForm) fornecedoresForm.hidden = !editable;
  if (contasPagarForm) contasPagarForm.hidden = !editable;
  if (contasReceberForm) contasReceberForm.hidden = !editable;
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

  setupSidebarCollapse();
  setupSidebarMobileDrawer();
  setupThemeToggle();
  setupCommandPalette();
}
