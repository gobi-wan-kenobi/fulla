// SPDX-License-Identifier: GPL-3.0-or-later
// POST /api/categorize: the optional model step of categorisation, for a
// signed-in person only. The browser sends the lines no rule or known
// merchant recognised; the answers are mapped onto the household's
// categories in the browser (lib/categorizer.ts). Off without OPENAI_API_KEY.
import { NextResponse } from "next/server";
import { askModel, categorizerEnabled, readItems } from "@/lib/server/categorizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cold fine-tuned model can take most of a minute to answer the first time (30 s timeout, one retry).
export const maxDuration = 120;

const env = () => ({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  FULLA_CATEGORIZER_MODEL: process.env.FULLA_CATEGORIZER_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
});

export async function GET() {
  return NextResponse.json({ enabled: categorizerEnabled(env()) }, { headers: { "cache-control": "no-store" } });
}

/** True when the bearer token is a live session of this project's Supabase Auth. */
async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!/^Bearer \S+$/.test(auth) || !url || !anon) return false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, { headers: { apikey: anon, authorization: auth }, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const e = env();
  if (!categorizerEnabled(e)) return NextResponse.json({ results: {}, stopped: "off" });
  if (!(await signedIn(req))) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const items = readItems(body);
  if (!items) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  return NextResponse.json(await askModel(items, e), { headers: { "cache-control": "no-store" } });
}
