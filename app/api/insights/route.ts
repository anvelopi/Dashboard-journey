import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  // Check if Anthropic key exists
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      enabled: false,
      message: "ANTHROPIC_API_KEY not configured. Add it to Vercel env vars to enable AI insights.",
    });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "No auth" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { keywords, pages, revenue, domain } = body;

    // Build context for Claude
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
        max_tokens: 4000,
        system: `Eres un consultor SEO experto. Analizas datos de Google Search Console y Google Analytics 4 para generar recomendaciones accionables priorizadas por impacto económico.

Responde SIEMPRE con el formato delimitado:
===REC===
TITULO: [título corto]
PRIORIDAD: [ALTA|MEDIA|BAJA]
FASE: [Descubrimiento|Investigación|Evaluación|Decisión|Compra|Post-venta]
TIPO: [SEO|CONTENIDO|TÉCNICO|CRO|ENLAZADO]
IMPACTO: [estimación en € o % de mejora]
ESFUERZO: [horas estimadas]
DESCRIPCION: [descripción detallada de 2-3 frases con datos específicos]
===END===

Genera entre 6 y 10 recomendaciones ordenadas por impacto descendente. Cada recomendación debe ser ESPECÍFICA para este dominio y usar datos reales del contexto proporcionado. NO generes recomendaciones genéricas.`,
        messages: [
          {
            role: "user",
            content: `Analiza estos datos del dominio ${domain} y genera recomendaciones SEO accionables:\n\n${context}`,
          },
        ],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Parse ===REC=== format
    const recs = parseRecommendations(text);

    return NextResponse.json({ enabled: true, recommendations: recs, raw: text });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Check if insights are available (GET)
export async function GET() {
  return NextResponse.json({
    enabled: !!process.env.ANTHROPIC_API_KEY,
  });
}

function buildContext(keywords: any[], pages: any[], revenue: any, domain: string): string {
  let ctx = `DOMINIO: ${domain}\n\n`;

  if (revenue) {
    ctx += `ECOMMERCE (30d): Revenue ${revenue.total}€, ${revenue.transactions} transacciones\n\n`;
  }

  if (keywords?.length) {
    ctx += `TOP 30 KEYWORDS GSC (28d):\n`;
    keywords.slice(0, 30).forEach((k: any) => {
      ctx += `- "${k.keys?.[0] || k.kw}" | clicks:${k.clicks} | imp:${k.impressions || k.imp} | CTR:${(k.ctr * 100 || k.ctr).toFixed(1)}% | pos:${(k.position || k.pos).toFixed(1)}\n`;
    });
    ctx += "\n";
  }

  if (pages?.length) {
    ctx += `TOP 20 PÁGINAS GA4 (30d):\n`;
    pages.slice(0, 20).forEach((p: any) => {
      const path = p.dimensionValues?.[0]?.value || p.page;
      const sessions = p.metricValues?.[0]?.value || p.sessions;
      const rev = p.metricValues?.[4]?.value || p.revenue || "0";
      ctx += `- ${path} | sesiones:${sessions} | revenue:${parseFloat(rev).toFixed(0)}€\n`;
    });
    ctx += "\n";
  }

  ctx += `INSTRUCCIONES ADICIONALES:\n`;
  ctx += `- Identifica keywords con muchas impresiones pero CTR bajo o posición >10 (oportunidades)\n`;
  ctx += `- Cruza páginas de GA4 con keywords de GSC para detectar content gaps\n`;
  ctx += `- Prioriza acciones que impacten en revenue (páginas con transacciones)\n`;
  ctx += `- Detecta problemas de enlazado interno (blog sin link a producto)\n`;
  ctx += `- Incluye estimación de impacto económico basada en los datos reales\n`;

  return ctx;
}

function parseRecommendations(text: string): any[] {
  const blocks = text.split("===REC===").filter((b) => b.includes("TITULO:"));
  return blocks.map((block) => {
    const get = (field: string) => {
      const m = block.match(new RegExp(`${field}:\\s*(.+?)(?:\\n|===)`));
      return m ? m[1].trim() : "";
    };
    return {
      title: get("TITULO"),
      priority: get("PRIORIDAD"),
      phase: get("FASE"),
      type: get("TIPO"),
      impact: get("IMPACTO"),
      effort: get("ESFUERZO"),
      description: get("DESCRIPCION"),
    };
  });
}
