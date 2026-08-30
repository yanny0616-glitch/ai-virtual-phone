import { NextRequest, NextResponse } from "next/server";

function serializeForInlineScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

/**
 * OAuth callback endpoint.
 * Authorization server redirects here with ?code=xxx&state=xxx
 * We render a simple page that posts the result back to the opener window.
 */
export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get("code") || "";
    const state = req.nextUrl.searchParams.get("state") || "";
    const error = req.nextUrl.searchParams.get("error") || "";
    const callbackPayload = {
        state,
        code,
        error,
        createdAt: Date.now(),
    };
    const serializedPayload = serializeForInlineScript(callbackPayload);

    // Return a minimal HTML page that communicates back to the opener
    const html = `<!DOCTYPE html><html><head><title>授权完成</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script>
  var payload = ${serializedPayload};
  try {
    window.localStorage.setItem("ai_phone_mcp_oauth_callback_v1", JSON.stringify(payload));
  } catch(e) {}
  try {
    if (window.opener) {
      window.opener.postMessage({
        type: "mcp-oauth-callback",
        code: payload.code,
        state: payload.state,
        error: payload.error
      }, window.location.origin);
    }
  } catch(e) {}
  setTimeout(function() {
    try {
      if (window.opener) {
        window.close();
        return;
      }
    } catch(e) {}
    window.location.replace("/");
  }, 800);
</script>
<p>授权完成，正在返回 Float...</p>
</body></html>`;

    return new NextResponse(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
