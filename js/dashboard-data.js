function filterByDateRange(records, start, end) {
  return records.filter((r) => r.data && r.data >= start && r.data <= end);
}

// Peso (g) tracks gold movement, which runs opposite to the cash Tipo:
// a "Saída" (cash out) is the store buying gold from someone (gold comes IN),
// an "Entrada" (cash in) is the store selling gold (gold goes OUT).
function computeKpis(records) {
  let entradas = 0;
  let saidas = 0;
  let pesoComprado = 0; // grams acquired, from "Saída" (cash-out) rows
  let pesoVendido = 0; // grams sold, from "Entrada" (cash-in) rows
  // R$ specifically tied to those same gold-carrying rows (2026-10-11,
  // requested so "Compras/Vendas de ouro" shows not just grams but what was
  // actually paid/received for them) — the same typeof r.peso === "number"
  // test already used to decide a row is a gold movement at all, since a
  // non-gold row's Peso/Quantidade cell reads back as null, never 0 (see
  // converterNumero in js/esquema.js), so this never mixes in unrelated Valor.
  let valorPesoComprado = 0;
  let valorPesoVendido = 0;
  records.forEach((r) => {
    if (r.tipo === "Entrada") {
      entradas += r.valor;
      if (typeof r.peso === "number") {
        pesoVendido += r.peso;
        valorPesoVendido += r.valor;
      }
    } else if (r.tipo === "Saída") {
      saidas += Math.abs(r.valor);
      if (typeof r.peso === "number") {
        pesoComprado += r.peso;
        valorPesoComprado += Math.abs(r.valor);
      }
    }
  });
  return { entradas, saidas, saldo: entradas - saidas, pesoComprado, pesoVendido, valorPesoComprado, valorPesoVendido };
}

function computeByLoja(records) {
  const map = new Map();
  records.forEach((r) => {
    const loja = r.loja || "Sem loja";
    if (!map.has(loja)) map.set(loja, { entradas: 0, saidas: 0 });
    const bucket = map.get(loja);
    if (r.tipo === "Entrada") bucket.entradas += r.valor;
    else if (r.tipo === "Saída") bucket.saidas += Math.abs(r.valor);
  });
  return Array.from(map.entries())
    .map(([loja, bucket]) => ({
      loja,
      entradas: bucket.entradas,
      saidas: bucket.saidas,
      saldo: bucket.entradas - bucket.saidas,
    }))
    .sort((a, b) => b.saldo - a.saldo);
}

function computeByCategoria(records, tipo) {
  const map = new Map();
  records.forEach((r) => {
    if (r.tipo !== tipo) return;
    const categoria = r.categoria || "Sem categoria";
    map.set(categoria, (map.get(categoria) || 0) + Math.abs(r.valor));
  });
  return Array.from(map.entries())
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);
}

function topNWithOthers(items, n) {
  if (items.length <= n) return items;
  const top = items.slice(0, n);
  const restSum = items.slice(n).reduce((sum, item) => sum + item.valor, 0);
  top.push({ categoria: "Outros", valor: restSum });
  return top;
}

function computeByMonth(records) {
  const map = new Map();
  records.forEach((r) => {
    if (!r.data) return;
    const key = `${r.data.getUTCFullYear()}-${String(r.data.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { entradas: 0, saidas: 0 });
    const bucket = map.get(key);
    if (r.tipo === "Entrada") bucket.entradas += r.valor;
    else if (r.tipo === "Saída") bucket.saidas += Math.abs(r.valor);
  });
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, bucket]) => ({ mes, entradas: bucket.entradas, saidas: bucket.saidas }));
}

const MONTH_LABELS = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

function formatMonthLabel(key) {
  const [year, month] = key.split("-");
  const label = MONTH_LABELS[Number(month) - 1] || month;
  return `${label}/${year.slice(2)}`;
}

// Time series for the little sparklines inside the KPI tiles: one bucket per
// day for ranges up to ~3 months, otherwise one per month. `saldo` is the
// running balance across the buckets. Real data only — an empty range yields
// empty arrays and the caller draws nothing.
function computeSeries(records, start, end) {
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  const monthly = spanDays > 92;
  const keyOf = (d) =>
    monthly
      ? d.getUTCFullYear() * 12 + d.getUTCMonth()
      : Math.floor((d.getTime() - start.getTime()) / 86400000);

  const buckets = new Map();
  records.forEach((r) => {
    if (!r.data || (r.tipo !== "Entrada" && r.tipo !== "Saída")) return;
    const key = keyOf(r.data);
    if (!buckets.has(key)) buckets.set(key, { entradas: 0, saidas: 0 });
    const bucket = buckets.get(key);
    if (r.tipo === "Entrada") bucket.entradas += r.valor;
    else bucket.saidas += Math.abs(r.valor);
  });

  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const series = { entradas: [], saidas: [], saldo: [] };
  let running = 0;
  keys.forEach((key) => {
    const bucket = buckets.get(key);
    running += bucket.entradas - bucket.saidas;
    series.entradas.push(bucket.entradas);
    series.saidas.push(bucket.saidas);
    series.saldo.push(running);
  });
  return series;
}
