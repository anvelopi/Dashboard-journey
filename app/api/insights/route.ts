export const maxDuration = 60;

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ enabled: !!process.env.ANTHROPIC_API_KEY });
}

export async function POST(req: Request) {
  const logs: string[] = [];
  const t0 = Date.now();

  logs.push("1. Start " + new Date().toISOString());
  logs.push("2. API key exists: " + !!process.env.ANTHROPIC_API_KEY);
  logs.push("3. API key length: " + (process.env.ANTHROPIC_API_KEY || "").length);

  try {
    logs.push("4. Calling Anthropic...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: "Responde solo: OK" }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    logs.push("5. Status: " + res.status);
    const text = await res.text();
    logs.push("6. Response length: " + text.length);
    logs.push("7. First 200 chars: " + text.slice(0, 200));
    logs.push("8. Time: " + (Date.now() - t0) + "ms");

    return NextResponse.json({ enabled: true, logs, journey: { keywords_classified: [], archetypes: [{ id: "A1", name: "Test OK", icon: "✅", desc: "Anthropic respondió en " + (Date.now() - t0) + "ms", pct: 100, color: "#00b4d8" }], pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
  } catch (err: any) {
    logs.push("ERROR: " + err.name + " - " + err.message);
    logs.push("Time: " + (Date.now() - t0) + "ms");
    return NextResponse.json({ enabled: true, logs, journey: { keywords_classified: [], archetypes: [{ id: "A1", name: "ERROR", icon: "❌", desc: err.name + ": " + err.message, pct: 100, color: "#b91c1c" }], pain_points: [], insights: {}, content_gaps: [], recommendations: [] } });
  }
}
