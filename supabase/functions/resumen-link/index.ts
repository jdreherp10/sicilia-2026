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
// en efectivo a la llegada, fuera de la plataforma. Los sacamos del texto.
type Tasa = { texto: string; monto: number | null; unidad: string | null; cat: string; efectivo: boolean };

const normTxt = (s: string) => s.replace(/\s+/g, " ").trim();

function montoDe(str: string): number | null {
  const cur = "(?:€|eur(?:os?)?|euro)";
  const n = "(\\d{1,4}(?:[.,]\\d{1,2})?)";
  const m = str.match(new RegExp(cur + "\\s*" + n, "i")) || str.match(new RegExp(n + "\\s*" + cur, "i"));
  if (!m) return null;
  const v = Number(m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return isNaN(v) ? null : v;
}

function unidadDe(str: string): string {
  const s = str.toLowerCase();
  const perPerson = /(per|a|por)\s+person\w*|\/\s*person|p\/?p\b|por\s+persona|a\s+persona/.test(s);
  const perNight = /(per|a|por)\s+(night|notte|noche)|\/\s*(night|notte|noche)|por\s+noche|a\s+notte|per\s+notte|(?:y|e|and)\s+(noche|notte|night)/.test(s)
    || (perPerson && /\b(noche|notte|nights?)\b/.test(s));
  if (perPerson && perNight) return "persona_noche";
  if (perNight) return "noche";
  if (perPerson) return "persona";
  return "estancia";
}

function categoriaDe(s: string): string {
  if (/cauzion\w*|deposito?\s+cauzional\w*|security\s+deposit|fianza|dep[oó]sito\s+reembols\w*|caparra/i.test(s)) return "deposito";
  if (/tassa|imposta|soggiorno|city\s*tax|tourist\s*tax|visitor'?s?\s*tax|tasa\s+tur|impuesto\s+tur|tasa\s+de\s+alojam/i.test(s)) return "tasa";
  if (/pulizi\w*|cleaning|limpiez\w*/i.test(s)) return "limpieza";
  return "efectivo";
}

function detectarTasas(texto: string): Tasa[] {
  if (!texto) return [];
  const frases = normTxt(texto).split(/(?<=[.!?])\s+|(?:\s*[•·\-–]\s+)|\n+/);
  const KEY = /(tassa|imposta)\s+di\s+soggiorno|city\s*tax|tourist\s*tax|visitor'?s?\s*tax|tasa\s+(tur[ií]stica|de\s+alojamiento)|impuesto\s+(tur[ií]stico|de\s+estancia)|soggiorno|in\s+contanti|en\s+efectivo|in\s+cash|paid?\s+in\s+cash|contanti|pago\s+en\s+efectivo|cash\s+(?:to|al|payment|on)|cauzion\w*|security\s+deposit|fianza|caparra/i;
  const CASH = /contanti|efectivo|cash/i;
  const out: Tasa[] = [];
  const vistos = new Set<string>();
  for (const f of frases) {
    if (!KEY.test(f)) continue;
    const texto = normTxt(f).slice(0, 200);
    if (vistos.has(texto)) continue;
    vistos.add(texto);
    const monto = montoDe(f);
    out.push({ texto, monto, unidad: monto ? unidadDe(f) : null, cat: categoriaDe(f), efectivo: CASH.test(f) });
    if (out.length >= 6) break;
  }
  return out;
}

// Extrae el texto completo de la descripción del bootstrap de Airbnb.
function descripcionAirbnb(html: string): string {
  const partes: string[] = [];
  // htmlDescription.htmlText (descripción principal)
  const i = html.indexOf('"htmlDescription"');
  if (i >= 0) {
    const m = html.slice(i, i + 8000).match(/"htmlText":"((?:[^"\\]|\\.)*)"/);
    if (m) partes.push(m[1]);
  }
  // Otros bloques de texto (reglas de la casa, notas del anfitrión) suelen traer las tasas
  const re = /"localizedStringWithTranslationPreference":"((?:[^"\\]|\\.)*)"/g;
  let mm: RegExpExecArray | null;
  let n = 0;
  while ((mm = re.exec(html)) !== null && n < 8) { partes.push(mm[1]); n++; }
  let t = partes.join("\n");
  // desescapar y quitar etiquetas
  t = t.replace(/\\u003c[^\\]*?\\u003e/g, " ").replace(/\\n/g, "\n").replace(/\\t/g, " ")
       .replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\u0026/g, "&")
       .replace(/<[^>]+>/g, " ");
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
