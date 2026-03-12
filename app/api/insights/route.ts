import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      enabled: false,
      message: "ANTHROPIC_API_KEY not configured",
    });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "No auth" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { keywords, pages, revenue, domain } = body;
    const context = buildContext(keywords, pages, revenue, domain);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Analiza estos datos del dominio " + domain + " y genera el Customer Journey SEO completo:\n\n" + context }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    let journey = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) journey = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("Failed to parse journey JSON:", e);
    }

    return NextResponse.json({ enabled: true, journey, raw: text });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

const SYSTEM_PROMPT = `Eres un consultor SEO experto especializado en Customer Journey Mapping. Analizas datos de Google Search Console y Google Analytics 4 para construir un mapa completo del customer journey SEO.

Devuelve un JSON con esta estructura exacta:

{
  "archetypes": [
    {"id":"A1","name":"nombre","icon":"emoji","desc":"descripción 2 frases","pct":35,"color":"#00b4d8"},
    {"id":"A2",...}, {"id":"A3",...}, {"id":"A4",...}
  ],
  "keywords_classified": [
    {"kw":"keyword","clicks":N,"imp":N,"ctr":N,"pos":N,"phase":"Fase","intent":"Intent","archs":["A1"]}
  ],
  "pain_points": [
    {"title":"titulo","desc":"descripcion","phases":["Fase"],"archs":["A1","A2"],"sev":5}
  ],
  "insights": {
    "A1": {
      "Descubrimiento": {"t":"qué piensa/busca","f":"qué siente","p":["pain1","pain2"],"g":["gain1","gain2"]},
      "Investigación": {...}, "Evaluación": {...}, "Decisión": {...}, "Compra": {...}, "Post-venta": {...}
    },
    "A2": {...}, "A3": {...}, "A4": {...}
  },
  "content_gaps": [
    {"arch":"A1","phase":"Fase","title":"titulo del gap","kws":"keywords relacionadas","prio":"alta"}
  ],
  "recommendations": [
    {"title":"titulo","priority":"ALTA","phase":"Fase","type":"SEO","impact":"estimación €","effort":"Xh","description":"descripcion detallada"}
  ]
}

REGLAS:
- Las fases son: Descubrimiento, Investigación, Evaluación, Decisión, Compra, Post-venta
- Las intenciones son: Informacional, Comercial, Transaccional, Navegacional
- Clasifica TODAS las keywords proporcionadas
- Los 4 arquetipos deben reflejar patrones reales de las keywords del dominio
- Los pain points deben basarse en datos reales (CTR bajo, posiciones malas, páginas sin conversión)
- Los insights por celda (arquetipo x fase) deben ser específicos para este dominio
- Genera 8-12 pain points, 12-18 content gaps, 6-10 recomendaciones
- Responde SOLO con el JSON, sin texto, sin backticks markdown`;

function buildContext(keywords: any[], pages: any[], revenue: any, domain: string): string {
  let ctx = "DOMINIO: " + domain + "\n";
  if (revenue) ctx += "ECOMMERCE (30d): Revenue " + revenue.total + " EUR, " + revenue.transactions + " transacciones, " + revenue.sessions + " sesiones\n\n";
  ctx += "KEYWORDS GSC (28d) - " + keywords.length + " keywords:\n";
  keywords.slice(0, 80).forEach((k: any) => { ctx += '"' + k.kw + '" | clicks:' + k.clicks + " | imp:" + k.imp + " | CTR:" + k.ctr + "% | pos:" + k.pos + "\n"; });
  ctx += "\n";
  if (pages?.length) {
    ctx += "PAGINAS GA4 (30d) - " + pages.length + " paginas:\n";
    pages.slice(0, 30).forEach((p: any) => { ctx += p.page + " | sesiones:" + p.sessions + " | revenue:" + p.revenue + "EUR | compras:" + p.purchases + "\n"; });
  }
  return ctx;
}
