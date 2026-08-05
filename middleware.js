export const config = { matcher: "/turnos" };

const GOOGLE_FORM_URL =
  "https://script.google.com/macros/s/AKfycbz3iz8QL36v2soVJVFwNXE_pP2WkpaejfaDouC4fbBpgd1rIzP-1r6afiU2wI793CeDXg/exec";
const SITE_URL = "https://od-francovinzon.vercel.app/turnos";

const EMBEDDED_BROWSER_RE = /Instagram|FBAN|FBAV|FB_IAB|FBSV|TikTok|musical_ly/i;

export default function middleware(request) {
  const ua = request.headers.get("user-agent") || "";

  if (EMBEDDED_BROWSER_RE.test(ua)) {
    return new Response(openInBrowserPage(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
      },
    });
  }

  return Response.redirect(GOOGLE_FORM_URL, 302);
}

function openInBrowserPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Abrí este link en tu navegador | Franco Vinzón Odontólogo</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/assets/isologo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --navy: #1E3A5F; --gold: #D4A24C; --bg: #FAF9F6; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Inter", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: #2A2A2A;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
    text-align: center;
    line-height: 1.6;
  }
  .card { max-width: 380px; }
  .logo { height: 44px; margin-bottom: 28px; }
  h1 {
    font-family: "Fraunces", Georgia, serif;
    color: var(--navy);
    font-weight: 600;
    font-size: 1.6rem;
    margin-bottom: 16px;
    letter-spacing: -0.01em;
  }
  p { color: #5D7A99; margin-bottom: 10px; font-size: .98rem; }
  .steps {
    text-align: left;
    background: white;
    border-radius: 16px;
    padding: 20px 22px;
    margin: 24px 0;
    box-shadow: 0 10px 30px rgba(30,58,95,.1);
  }
  .steps p { color: #2A2A2A; margin-bottom: 8px; font-size: .95rem; }
  .steps p:last-child { margin-bottom: 0; }
  button {
    font-family: inherit;
    font-weight: 600;
    font-size: .95rem;
    background: var(--gold);
    color: white;
    border: 0;
    padding: 14px 30px;
    border-radius: 100px;
    box-shadow: 0 6px 22px rgba(212,162,76,.5);
    cursor: pointer;
  }
  button:active { opacity: .85; }
  .copied { color: var(--navy); font-weight: 600; font-size: .9rem; margin-top: 14px; display: none; }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/assets/logo-horizontal.png" alt="Franco Vinzón Odontólogo">
    <h1>Para reservar tu turno, abrí este link en tu navegador</h1>
    <p>Este link no funciona bien dentro de la app. Es rápido:</p>
    <div class="steps">
      <p>1. Tocá los tres puntitos (⋮) o el ícono de compartir, arriba a la derecha.</p>
      <p>2. Elegí "Abrir en el navegador" o "Abrir en Safari".</p>
    </div>
    <button id="copy-btn" onclick="copyLink()">Copiar link</button>
    <p class="copied" id="copied-msg">¡Copiado! Pegalo en Safari o Chrome.</p>
  </div>
  <script>
    function copyLink() {
      const url = "${SITE_URL}";
      const msg = document.getElementById("copied-msg");
      function showCopied() { msg.style.display = "block"; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(showCopied).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      function fallbackCopy() {
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        try { document.execCommand("copy"); showCopied(); } catch (e) {}
        document.body.removeChild(el);
      }
    }
  </script>
</body>
</html>`;
}
