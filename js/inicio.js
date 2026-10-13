// Runs in <head>, before anything is drawn. When this tab already has a valid
// session (a page reload), the login screen must not flash while the app checks
// the account and loads: <html> gets the class "retomando", which shows a quiet
// loading screen instead (css/style.css). js/app.js removes the class the moment
// a real screen is shown (hideAllScreens). The keys are the ones js/auth.js uses.
function deveRetomarSessao(armazenamento, chaveToken, chaveExpira, agora) {
  try {
    const token = armazenamento.getItem(chaveToken);
    const expira = Number(armazenamento.getItem(chaveExpira) || 0);
    return Boolean(token) && expira > agora + 30000;
  } catch (err) {
    return false;
  }
}

(function () {
  const agora = Date.now();
  let retomar = false;
  try {
    retomar = deveRetomarSessao(window.sessionStorage, "ipanema_gis_access_token", "ipanema_gis_token_expires_at", agora);
  } catch (err) {
    retomar = false;
  }
  // "Manter conectado neste aparelho" (js/auth.js): a password session kept in
  // localStorage so it survives a closed tab/app — same quiet-resume treatment.
  if (!retomar) {
    try {
      retomar = deveRetomarSessao(window.localStorage, "financegold_lembrar_token", "financegold_lembrar_expira_em", agora);
    } catch (err) {
      retomar = false;
    }
  }
  if (retomar) {
    document.documentElement.classList.add("retomando");
    // Safety net: if the app never gets to draw a screen (a script failed), do not
    // leave the person on a blank loading screen.
    setTimeout(() => document.documentElement.classList.remove("retomando"), 25000);
  }
})();
