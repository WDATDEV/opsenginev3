import { NextRequest, NextResponse } from "next/server";

const API = (process.env.API_UPSTREAM ?? "http://localhost:3011").replace(/\/$/, "");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxy(request: NextRequest, path: string[]) {
  const url = `${API}/${path.join("/")}${request.nextUrl.search}`;
  const headers = new Headers();
  const token = request.cookies.get("oe_tracking")?.value;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const upstream = await fetch(url, { method: request.method, headers, body, cache: "no-store" });
  const payload = await upstream.arrayBuffer();
  const response = new NextResponse(payload, { status: upstream.status });
  const type = upstream.headers.get("content-type");
  if (type) response.headers.set("content-type", type);

  const setCookie = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    response.headers.append("set-cookie", cookie);
  }

  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}
