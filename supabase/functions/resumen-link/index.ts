// ============================================================
// Sicilia 2026 · Edge Function "resumen-link"
// Recibe { url } → devuelve el resumen del anuncio leyendo la página
// del lado del servidor (el navegador no puede: CORS).
//
// Hallazgos verificados (2026-07-17, probando contra los sitios reales):
//  · AIRBNB: responde 200 al User-Agent de WhatsApp (a facebookexternalhit,
//    Googlebot y Twitterbot les da 403; a Chrome, 429). El og:title trae
//    "<tipo> in <sitio> · ★4.9 · 1 bedroom · 1 bed · 1 private bath" y el
//    HTML trae "personCapacity" → sacamos nombre, foto, rating, habitaciones,
//    camas, baños y CAPACIDAD.
//  · PRECIO: siempre viene null (lo carga por JS y depende de fechas) → manual.
//  · BOOKING: bloqueado. A los UA de bot los redirige a la página de ciudad
//    (/city/…) con HTTP 200 — devuelve un genérico que PARECE válido ("10 Best
//    Palermo Hotels"). A Chrome le da 202 sin etiquetas. Por eso lo detectamos
//    y devolvemos un error honesto en vez de basura.
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA = "WhatsApp/2.19.81 A";
const MAX_HTML = 2_000_000;
const TIMEOUT_MS = 15_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** La función es pública: no dejar que sirva de puente a destinos internos. */
function hostPermitido(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === "::1" || h === "[::1]") return false;
  return true;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

function meta(html: string, prop: string): string | null {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, "i"),
  ];
  for (const re of res) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return decode(m[1]);
  }
  return null;
}

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const n = Number(String(s).replace(",", "."));
  return isNaN(n) ? null : n;
};

// ---- Tasas / pagos en efectivo escondidos en la descripción ----
// Muchos caseros de Sicilia cobran la "tassa di soggiorno" y otros extras
// (limpieza, ropa de cama, consumos, depósito) en efectivo a la entrega,
// fuera de la plataforma, y los listan con comas en la descripción.
// Estrategia: localizar CADA monto en € y clasificarlo por su propio
// contexto acotado, sin que un cargo invada al vecino.
type Tasa = { texto: string; monto: number | null; unidad: string | null; cat: string; efectivo: boolean };

const normTxt = (s: string) => s.replace(/\s+/g, " ").trim();

// Categorías en orden de prioridad (la primera que casa gana).
const CATS: [string, RegExp][] = [
  ["deposito", /dep[oó]sito|deposito|cauzion\w*|fianza|caparra|security\s+deposit|damage\s+deposit|\bdeposits?\b/i],
  ["tasa", /impuesto|imposta|tassa|soggiorno|(?:city|tourist|visitor'?s?|accommodation|tourism)\s*tax|tasa\s+(?:tur\w*|de\s+aloj\w*|de\s+estancia)/i],
  ["limpieza", /limpiez\w*|pulizi\w*|cleaning/i],
  ["ropa", /s[aá]banas?|ropa\s+de\s+cama|lino|biancheria|lenzuola|linen|bed\s*linen|towels?|toallas?/i],
  ["consumo", /consumo?s?|utenze|utilities|luz|gas|electric\w*|\bagua\b|water/i],
];
function categoriaDe(win: string): string | null {
  for (const [c, re] of CATS) if (re.test(win)) return c;
  return null;
}

// La unidad SIEMPRE sigue al monto ("€150 por semana", "€2 por día por persona").
function unidadDe(after: string): string {
  const s = " " + after.toLowerCase() + " ";
  if (/por\s+d[ií]a\s+por\s+persona|per\s+day\s+per\s+person|per\s+person\s+per\s+(?:night|day)|a\s+persona\s+a\s+notte|por\s+persona\s+(?:y|por|al)\s+(?:noche|d[ií]a)/.test(s)) return "persona_noche";
  if (/por\s+semana|\/\s*sem\w*|\/se\b|per\s+week|a\s+settimana|semanal/.test(s)) return "semana";
  if (/por\s+persona|per\s+person|a\s+persona|p\/?p\b|x\s+persona/.test(s)) return "persona";
  if (/por\s+(?:noche|d[ií]a)|per\s+(?:night|day)|a\s+notte/.test(s)) return "noche";
  return "estancia";
}

const CASH_RE = /efectivo|contanti|cash/i;
const numGlobal = /(?:€|eur(?:os?)?)\s*(\d{1,4}(?:[.,]\d{1,2})?)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur(?:os?)?|euros?)/gi;
const aNum = (s: string): number | null => {
  const n = Number(String(s).replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
};

function detectarTasas(texto: string): Tasa[] {
  if (!texto) return [];
  const t = normTxt(texto);
  const cashContext = CASH_RE.test(t);
  // 1) posiciones de todos los montos (para acotar la ventana entre vecinos)
  const montos: { p: number; end: number; raw: string; val: number | null }[] = [];
  let mm: RegExpExecArray | null;
  numGlobal.lastIndex = 0;
  while ((mm = numGlobal.exec(t)) !== null) {
    montos.push({ p: mm.index, end: mm.index + mm[0].length, raw: mm[0], val: aNum(mm[1] || mm[2]) });
    if (montos.length > 60) break;
  }
  const items: Tasa[] = [];
  for (let k = 0; k < montos.length; k++) {
    const cur = montos[k];
    if (cur.val == null) continue;
    const prevEnd = k > 0 ? montos[k - 1].end : 0;
    const nextStart = k < montos.length - 1 ? montos[k + 1].p : t.length;
    // BEFORE: desde el monto anterior o el último separador fuerte (. ; • salto). El ":" NO corta (etiqueta antes del valor).
    const bslice = t.slice(Math.max(prevEnd, cur.p - 60), cur.p);
    const sepB = Math.max(bslice.lastIndexOf(". "), bslice.lastIndexOf(";"), bslice.lastIndexOf("•"), bslice.lastIndexOf("\n"));
    const before = sepB >= 0 ? bslice.slice(sepB + 1) : bslice;
    // AFTER: hasta el próximo monto o el próximo separador (, . ; : • salto)
    const aslice = t.slice(cur.end, Math.min(nextStart, cur.end + 30));
    const sepA = aslice.search(/[,.;:•\n]/);
    const after = sepA >= 0 ? aslice.slice(0, sepA) : aslice;
    const cat = categoriaDe(before) || categoriaDe(after);
    if (!cat && !CASH_RE.test(before + after) && !cashContext) continue; // sin categoría ni contexto efectivo → ignorar
    items.push({
      texto: normTxt(before + " " + cur.raw + " " + after).slice(0, 160),
      monto: cur.val,
      unidad: unidadDe(after),
      cat: cat || "efectivo",
      efectivo: CASH_RE.test(before + after) || cashContext,
    });
  }
  // 2) dedup por categoría: preferir la unidad más específica (el texto se repite entre bloques)
  const espec: Record<string, number> = { persona_noche: 5, semana: 4, persona: 3, noche: 2, estancia: 1 };
  const byCat: Record<string, Tasa> = {};
  for (const it of items) {
    const prev = byCat[it.cat];
    if (!prev || (espec[it.unidad || ""] || 0) > (espec[prev.unidad || ""] || 0)) byCat[it.cat] = it;
  }
  return Object.values(byCat).slice(0, 8);
}

// Extrae y limpia el texto completo de la descripción del bootstrap de Airbnb.
function descripcionAirbnb(html: string): string {
  const partes: string[] = [];
  const i = html.indexOf('"htmlDescription"');
  if (i >= 0) {
    const m = html.slice(i, i + 8000).match(/"htmlText":"((?:[^"\\]|\\.)*)"/);
    if (m) partes.push(m[1]);
  }
  // Otros bloques (reglas de la casa, notas del anfitrión) suelen traer las tasas
  const re = /"localizedStringWithTranslationPreference":"((?:[^"\\]|\\.)*)"/g;
  let mm: RegExpExecArray | null;
  let n = 0;
  while ((mm = re.exec(html)) !== null && n < 8) { partes.push(mm[1]); n++; }
  return partes.map(limpiarBloque).join("\n");
}

// Desescapa un valor de string JSON (\\uXXXX, \\n, \\", \\/) y quita etiquetas HTML.
function limpiarBloque(s: string): string {
  let t: string;
  try { t = JSON.parse('"' + s.replace(/\n/g, "\\n") + '"'); }
  catch {
    t = s.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\u0026/gi, "&")
         .replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/");
  }
  t = t.replace(/<[^>]+>/g, " ");
  return decode(t);
}

/** Lee las especificaciones del og:title de Airbnb (inglés y español). */
function specsAirbnb(titulo: string) {
  const rating = num(titulo.match(/★\s*([\d.,]+)/)?.[1]);
  const habitaciones = num(titulo.match(/([\d.,]+)\s*(?:bedrooms?|dormitorios?|habitaci[oó]n(?:es)?|rec[aá]maras?)/i)?.[1]);
  // "bed" sin que le siga "room": distingue "1 bed" de "1 bedroom".
  const camas = num(titulo.match(/([\d.,]+)\s*(?:beds?(?!room)|camas?)\b/i)?.[1]);
  const banos = num(titulo.match(/([\d.,]+)\s*(?:(?:shared|private|half|compartido|privado)\s+)?(?:bathrooms?|baths?|ba[ñn]os?)/i)?.[1]);
  return { rating, habitaciones, camas, banos };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usa POST." }, 405);

  let url = "";
  try {
    const body = await req.json();
    url = String(body?.url ?? "").trim();
  } catch {
    return json({ error: "Cuerpo inválido." }, 400);
  }
  if (!url) return json({ error: "Falta el link." }, 400);
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let target: URL;
  try { target = new URL(url); } catch { return json({ error: "Ese link no es válido." }, 400); }
  if (!hostPermitido(target)) return json({ error: "Ese destino no está permitido." }, 400);

  const host = target.hostname.toLowerCase().replace(/^www\./, "");
  const esAirbnb = /(^|\.)airbnb\.[a-z.]+$/.test(host) || host === "abnb.me";
  const esBooking = /(^|\.)booking\.com$/.test(host);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(target.toString(), {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
    });
  } catch (e) {
    clearTimeout(t);
    const abortado = e instanceof Error && e.name === "AbortError";
    return json({ error: abortado ? "El anuncio tardó demasiado en responder." : "No se pudo abrir el link." }, 502);
  }
  clearTimeout(t);

  if (res.status === 403 || res.status === 429 || res.status === 202) {
    return json({ error: `${host} bloqueó la lectura automática (${res.status}). Llena los datos a mano.` }, 502);
  }
  if (!res.ok) return json({ error: `El anuncio respondió ${res.status}.` }, 502);

  const ctype = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(ctype)) return json({ error: "Ese link no es una página web." }, 415);

  const final = new URL(res.url || target.toString());

  // Booking desvía los bots a la página de ciudad y responde 200: eso NO es el anuncio.
  if (esBooking) {
    const eraFicha = /\/hotel\//i.test(target.pathname);
    const sigueEnFicha = /\/hotel\//i.test(final.pathname);
    if (!eraFicha || !sigueEnFicha || /\/city\//i.test(final.pathname)) {
      return json({ error: "Booking bloquea la lectura automática de sus anuncios. Copia los datos a mano (el link sí se guarda)." }, 502);
    }
  }

  const html = (await res.text()).slice(0, MAX_HTML);

  const ogTitle = meta(html, "og:title") ?? meta(html, "twitter:title");
  const ogDesc = meta(html, "og:description") ?? meta(html, "twitter:description") ?? meta(html, "description");
  const ogImg = meta(html, "og:image") ?? meta(html, "og:image:secure_url") ?? meta(html, "twitter:image");

  let nombre: string | null = null;
  let descripcion: string | null = null;
  let rating: number | null = null;
  let habitaciones: number | null = null;
  let camas: number | null = null;
  let banos: number | null = null;
  let capacidad: number | null = null;

  let textoTasas = ogDesc || "";
  if (esAirbnb && ogTitle) {
    // En Airbnb el og:description es el título real del anuncio y el og:title trae las specs.
    nombre = ogDesc || ogTitle;
    descripcion = ogTitle;
    const s = specsAirbnb(ogTitle);
    rating = s.rating; habitaciones = s.habitaciones; camas = s.camas; banos = s.banos;
    capacidad = num(html.match(/"personCapacity"\s*:\s*(\d+)/)?.[1]);
    const larga = descripcionAirbnb(html);
    if (larga) textoTasas = larga; // la descripción completa es donde viven las tasas
  } else {
    nombre = ogTitle || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)![1]) : null);
    descripcion = ogDesc;
  }

  if (!nombre && !ogImg && !descripcion) {
    return json({ error: "El anuncio no expuso datos legibles. Llena los campos a mano." }, 422);
  }

  let foto: string | null = ogImg;
  if (foto) { try { foto = new URL(foto, final.toString()).toString(); } catch { foto = null; } }

  const tasas = detectarTasas(textoTasas);

  return json({
    nombre: nombre ? nombre.slice(0, 120) : null,
    foto,
    descripcion: descripcion ? descripcion.slice(0, 300) : null,
    rating, habitaciones, camas, banos, capacidad,
    tasas, // extras/tasas en efectivo detectadas en la descripción (puede venir vacío)
    fuente: host,
    // El precio de la reserva no viene: depende de fechas y lo carga por JS.
    aviso: "El precio base no se puede leer automáticamente: ponlo a mano.",
  });
});
