const OFFLINE_QUEUE_KEY_PREFIX = "financegold_offline_queue_";
const CACHE_KEY_PREFIX = "financegold_cache_";

// A raw fetch() failure (no connection at all) throws a TypeError, before
// ever getting an HTTP response. Every error this app throws deliberately
// (after checking response.ok) is a plain Error with a specific message —
// so a TypeError here reliably means "we're offline," not "the API said no."
function isNetworkError(err) {
  return err instanceof TypeError;
}

// For actions that are deliberately NOT queued for later (they depend on a
// specific row's current state, so blindly replaying them once back online
// risks silently clobbering a change someone else made in the meantime) —
// gives the user a clear "you need a connection" message instead of a raw
// "Failed to fetch".
function describeSaveError(err) {
  if (isNetworkError(err)) {
    return "Sem internet. Essa ação precisa de conexão — tente novamente quando estiver online.";
  }
  return `Erro ao salvar: ${err.message}`;
}

// Just the reason, for messages that already start with their own "Erro ao ...:".
function mensagemDoErro(err) {
  if (isNetworkError(err)) {
    return "Sem internet. Essa ação precisa de conexão — tente novamente quando estiver online.";
  }
  return err && err.message ? err.message : String(err);
}

function getQueueKey() {
  return `${OFFLINE_QUEUE_KEY_PREFIX}${CONFIG.SPREADSHEET_ID}`;
}

function getQueue() {
  try {
    const raw = localStorage.getItem(getQueueKey());
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveQueueToStorage(queue) {
  try {
    localStorage.setItem(getQueueKey(), JSON.stringify(queue));
  } catch (err) {
    // best effort — losing the queue means losing offline-entered data, but
    // there's nothing more to fall back to if storage itself is unavailable
  }
}

function enqueueWrite(type, payload) {
  const queue = getQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload,
    criadoEm: new Date().toISOString(),
  });
  saveQueueToStorage(queue);
  updateOfflineBanner();
}

function removeFromQueue(id) {
  saveQueueToStorage(getQueue().filter((item) => item.id !== id));
}

// Replays queued items in the order they were created. Stops at the first
// item that still fails for network reasons (keeps the rest queued for next
// time); an item that fails for a real API reason (not network) is dropped
// with a visible warning instead of jamming the queue forever.
async function flushQueue() {
  const queue = getQueue();
  if (queue.length === 0) return;

  for (const item of queue) {
    try {
      if (item.type === "lancamento") {
        await submitLancamentoValues(item.payload, accessToken);
      } else if (item.type === "estoque-novo") {
        await createEstoqueItem(item.payload, accessToken);
      } else if (item.type === "fornecedor-novo") {
        await createFornecedor(item.payload, accessToken);
      } else if (item.type === "conta-pagar-novo") {
        await createConta("pagar", item.payload, accessToken);
      } else if (item.type === "conta-receber-novo") {
        await createConta("receber", item.payload, accessToken);
      }
      removeFromQueue(item.id);
    } catch (err) {
      if (isNetworkError(err)) break;
      console.error("Falha ao sincronizar item pendente:", item, err);
      removeFromQueue(item.id);
      alert(`Um item pendente não pôde ser sincronizado e foi descartado: ${err.message}`);
    }
  }

  updateOfflineBanner();
  if (typeof refreshAllData === "function") {
    try {
      await refreshAllData();
    } catch (err) {
      console.error(err);
    }
  }
}

function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;

  const pending = getQueue().length;
  const offline = !navigator.onLine;

  // Being offline is deliberately silent now (the app just keeps showing the
  // last loaded data). The banner only appears when there is entered-offline
  // data still waiting to sync, since that is something the user must know
  // about — otherwise a saved lançamento would seem to have vanished.
  if (pending === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  if (offline) {
    banner.textContent = `${pending} pendente(s) para sincronizar quando a conexão voltar.`;
  } else {
    banner.textContent = `Sincronizando ${pending} pendente(s)...`;
  }
}

// --- Last-known-good data cache, for viewing (not editing) while offline ---

function cacheKey(name) {
  return `${CACHE_KEY_PREFIX}${name}_${CONFIG.SPREADSHEET_ID}`;
}

function saveDataCache(name, data) {
  try {
    localStorage.setItem(cacheKey(name), JSON.stringify(data));
  } catch (err) {
    // offline viewing is a nicety, not core functionality — ignore quota errors
  }
}

function loadDataCache(name) {
  try {
    const raw = localStorage.getItem(cacheKey(name));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// On an explicit sign-out, business data cached for offline viewing must not stay
// on a shared computer. The queue of entries typed offline and not yet sent is
// KEPT: dropping it would silently lose someone's work.
function clearCachedBusinessData() {
  try {
    Object.keys(localStorage).forEach((key) => {
      if (
        key.indexOf(CACHE_KEY_PREFIX) === 0 ||
        key.indexOf("financegold_abas_") === 0 ||
        key.indexOf("financegold_esquema_") === 0 ||
        key === "financegold_last_session"
      ) {
        localStorage.removeItem(key);
      }
    });
  } catch (err) {
    // nothing to clear / storage unavailable
  }
}

function serializeLancamentos(records) {
  return records.map((r) => ({ ...r, data: r.data ? r.data.toISOString() : null }));
}

function deserializeLancamentos(cached) {
  return cached.map((r) => ({ ...r, data: r.data ? new Date(r.data) : null }));
}

function serializeExtrato(itens) {
  return itens.map((i) => ({ ...i, data: i.data ? i.data.toISOString() : null }));
}

function deserializeExtrato(cached) {
  return cached.map((i) => ({ ...i, data: i.data ? new Date(i.data) : null }));
}

function serializeEstoque(items) {
  return items.map((i) => ({
    ...i,
    dataCompra: i.dataCompra ? i.dataCompra.toISOString() : null,
    dataVenda: i.dataVenda ? i.dataVenda.toISOString() : null,
  }));
}

function deserializeEstoque(cached) {
  return cached.map((i) => ({
    ...i,
    dataCompra: i.dataCompra ? new Date(i.dataCompra) : null,
    dataVenda: i.dataVenda ? new Date(i.dataVenda) : null,
  }));
}

// Runs a live fetch and caches the result; on a NETWORK failure specifically,
// falls back to whatever was last cached instead of blocking the whole app.
// A real API error (permission, bad request) still throws — that's not what
// "offline" means, and hiding it behind stale data would be worse.
async function fetchWithOfflineFallback(fetchFn, cacheName, serialize, deserialize) {
  try {
    const data = await fetchFn();
    saveDataCache(cacheName, serialize ? serialize(data) : data);
    return { data, fromCache: false };
  } catch (err) {
    if (isNetworkError(err)) {
      const cached = loadDataCache(cacheName);
      if (cached) {
        return { data: deserialize ? deserialize(cached) : cached, fromCache: true };
      }
    }
    throw err;
  }
}

window.addEventListener("online", () => {
  updateOfflineBanner();
  flushQueue();
});

window.addEventListener("offline", () => {
  updateOfflineBanner();
});
