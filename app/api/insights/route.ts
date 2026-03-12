import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false, message: "No API key" });
  }
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "No auth" }, { status: 401 });

  try {
    const body = await req.json();
    const { keywords, pages, revenue, domain } = body;

    // STEP 1: Classify keywords locally (fast, no API call)
    const classified = classifyKeywords(keywords || []);

    // STEP 2: Build compact context for Claude (only top 40 kws + 15 pages)
    const ctx = buildContext(classified.slice(0, 40), (pages || []).slice(0, 15), revenue, domain);

    // STEP 3: Call Claude for qualitative insights only (smaller response = faster)
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 6000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: ctx }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return NextResponse.json({ enabled: true, journey: { keywords_classified: classified }, error: "API " + response.status });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let aiData = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) aiData = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("JSON parse error:", e, "Raw text length:", text.length);
    }

    // Merge: local classification + AI qualitative data
    const journey = {
      archetypes: aiData?.archetypes || buildDefaultArchetypes(domain),
      keywords_classified: classified,
      pain_points: aiData?.pain_points || [],
      insights: aiData?.insights || {},
      content_gaps: aiData?.content_gaps || [],
      recommendations: aiData?.recommendations || [],
    };

    return NextResponse.json({ enabled: true, journey });
  } catch (err: any) {
    console.error("Insights error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

// ═══ LOCAL KEYWORD CLASSIFICATION (instant, no API) ═══
function classifyKeywords(keywords: any[]): any[] {
  return keywords.map((k: any) => {
    const kw = (k.kw || "").toLowerCase();
    return {
      ...k,
      phase: detectPhase(kw, k.pos, k.ctr),
      intent: detectIntent(kw),
      archs: detectArchs(kw),
    };
  });
}

function detectPhase(kw: string, pos: number, ctr: number): string {
  // Post-venta: recambios, repuestos, manual, piezas
  if (/recambio|repuesto|manual|pieza|part|replacement|invernante|invernaje/.test(kw)) return "Post-venta";
  // Compra: brand search
  if (/quimipool|quimpool|quimipol/.test(kw)) return "Compra";
  // Decisión: modelo concreto, referencia, SKU
  if (/^\d{4,}|tekna evo|seko |espa |dolphin |innowater |filtro star|zodiac |beatbot |wybot /.test(kw) && pos < 8) return "Decisión";
  // Investigación: cómo, qué es, comparación, vs, diferencia
  if (/como |cómo |que es|qué es|diferencia|comparati|vs |mejor |cual /.test(kw)) return "Investigación";
  // Evaluación: categorías de producto genéricas con intención de compra
  if (/limpiafondos|clorador|depuradora|filtro arena|bomba dosificadora|fotometro|cubierta|robot piscina|valla/.test(kw) && !/como |cómo /.test(kw)) return "Evaluación";
  // Descubrimiento: genérico informacional
  return "Descubrimiento";
}

function detectIntent(kw: string): string {
  if (/quimipool|quimpool|quimipol|seko |astralpool |espa |zodiac |moodle/.test(kw)) return "Navegacional";
  if (/comprar|precio|barato|oferta|tienda|^\d{4,}/.test(kw)) return "Transaccional";
  if (/mejor|comparar|comparativa|vs |opiniones|review|alternativa|top /.test(kw)) return "Comercial";
  if (/como |cómo |que es|qué es|diferencia|cuando|por que|tutorial|guia/.test(kw)) return "Informacional";
  // Default by position: low position = more transactional
  return "Comercial";
}

function detectArchs(kw: string): string[] {
  const archs: string[] = [];
  // A4 Professional: bombas dosificadoras, paneles control, seko, cuadro, kontrol
  if (/dosificadora|seko|kontrol|cuadro electrico|panel control|tekna/.test(kw)) archs.push("A4");
  // A3 Renovador: robot, sin cable, automatico, clorador salino, cubierta, beatbot, wybot
  if (/robot|sin cable|automatico|automático|clorador salino|cubierta|beatbot|wybot|zodiac free/.test(kw)) archs.push("A3");
  // A2 Experto: recambios, orp, valvula selectora, problemas, pierde agua, vidrio filtrante
  if (/recambio|repuesto|orp|valvula|pierde agua|vidrio filtrante|arena filtro|calibrar|sonda|manual/.test(kw)) archs.push("A2");
  // A1 Novel: genérico, depuradora, productos piscina, mantenimiento, cloro, filtro (basic)
  if (/depuradora|productos.*piscina|mantenimiento|cloro para|filtro piscina|como |cómo |gresite|valla|agua cristalina|primera/.test(kw)) archs.push("A1");
  // Brand = all
  if (/quimipool/.test(kw)) return ["A1","A2","A3","A4"];
  // Default
  if (archs.length === 0) archs.push("A1");
  return archs;
}

function buildDefaultArchetypes(domain: string) {
  return [
    {id:"A1",name:"Propietario Novel",icon:"🏊",desc:"Primera temporada con piscina. Busca equipamiento básico y guías.",pct:35,color:"#00b4d8"},
    {id:"A2",name:"Mantenedor Experto",icon:"🔧",desc:"Veterano. Busca recambios, soluciones técnicas. Compra recurrente.",pct:30,color:"#0d6e5b"},
    {id:"A3",name:"Renovador",icon:"⚡",desc:"Quiere automatizar: robot sin cable, clorador salino. Ticket alto.",pct:20,color:"#d97706"},
    {id:"A4",name:"Profesional",icon:"🏗️",desc:"Instalador/piscinero. Bombas dosificadoras, equipos técnicos. B2B.",pct:15,color:"#7c3aed"},
  ];
}

// ═══ COMPACT CONTEXT FOR CLAUDE ═══
function buildContext(keywords: any[], pages: any[], revenue: any, domain: string): string {
  let ctx = "Dominio: " + domain + "\n";
  if (revenue) ctx += "Revenue 30d: " + revenue.total + "EUR, " + revenue.transactions + " transacciones\n\n";

  ctx += "Top 40 keywords GSC (ya clasificadas por fase):\n";
  keywords.forEach((k: any) => {
    ctx += k.phase + " | " + k.intent + " | " + k.archs.join(",") + " | \"" + k.kw + "\" clicks:" + k.clicks + " imp:" + k.imp + " pos:" + k.pos + "\n";
  });

  if (pages.length) {
    ctx += "\nTop 15 paginas GA4:\n";
    pages.forEach((p: any) => {
      ctx += p.page + " | ses:" + p.sessions + " rev:" + p.revenue + "EUR\n";
    });
  }

  ctx += "\nGenera el JSON con las secciones indicadas en el system prompt. Las keywords ya están clasificadas - NO las incluyas en tu respuesta. Solo genera: archetypes, pain_points, insights, content_gaps, recommendations.";
  return ctx;
}

const SYSTEM_PROMPT = `Eres un consultor SEO experto. Analiza los datos proporcionados y devuelve SOLO un JSON (sin texto ni backticks) con esta estructura:

{
  "archetypes": [
    {"id":"A1","name":"nombre","icon":"emoji","desc":"2 frases específicas para este dominio","pct":35,"color":"#00b4d8"},
    {"id":"A2","name":"...","icon":"...","desc":"...","pct":30,"color":"#0d6e5b"},
    {"id":"A3","name":"...","icon":"...","desc":"...","pct":20,"color":"#d97706"},
    {"id":"A4","name":"...","icon":"...","desc":"...","pct":15,"color":"#7c3aed"}
  ],
  "pain_points": [
    {"title":"titulo corto","desc":"1 frase con datos","phases":["Fase"],"archs":["A1"],"sev":5}
  ],
  "insights": {
    "A1": {
      "Descubrimiento": {"t":"busca...","f":"siente...","p":["pain1"],"g":["gain1"]},
      "Investigación": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Evaluación": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Decisión": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Compra": {"t":"...","f":"...","p":["..."],"g":["..."]},
      "Post-venta": {"t":"...","f":"...","p":["..."],"g":["..."]}
    },
    "A2": { ... 6 fases ... },
    "A3": { ... 6 fases ... },
    "A4": { ... 6 fases ... }
  },
  "content_gaps": [
    {"arch":"A1","phase":"Fase","title":"titulo","kws":"keywords","prio":"alta"}
  ],
  "recommendations": [
    {"title":"titulo","priority":"ALTA","phase":"Fase","type":"SEO","impact":"estimacion","effort":"Xh","description":"1-2 frases"}
  ]
}

REGLAS:
- 4 arquetipos basados en los patrones reales de las keywords
- 8-10 pain points con severidad 1-5, basados en datos reales (CTR bajo, posiciones malas)
- Insights para CADA celda (4 arquetipos x 6 fases = 24 celdas). Cada celda: t (piensa), f (siente), p (array pains), g (array gains). Sé CONCISO: 1 frase por campo.
- 10-15 content gaps
- 6-8 recomendaciones ordenadas por impacto
- NO incluyas keywords_classified (ya están clasificadas localmente)
- Responde SOLO con el JSON`;
