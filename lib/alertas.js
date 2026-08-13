// Alerta por email cuando algo falla de verdad — es decir, después de agotar los
// reintentos automáticos de lib/retry.js, cuando ya no queda otra que mostrarle un
// error al paciente/secretaria. El objetivo es que Fausto se entere solo, sin que
// nadie tenga que reportarle "no me anduvo el sitio".
//
// Usa la API REST de Resend directo por fetch (sin sumar una dependencia nueva a
// package.json) — nivel gratis, alcanza de sobra para el volumen bajo de fallas reales
// que se espera acá. Necesita la variable de entorno RESEND_API_KEY (Vercel →
// Settings → Environment Variables, ver CLAUDE.md) — sin ella, avisarFallo() no hace
// más que un console.error: NUNCA tira, nunca puede romper el endpoint que la llama,
// para que la ausencia de esta config no empeore nada.
const EMAIL_ALERTA = 'faustovinzon9@icloud.com';

export async function avisarFallo({ endpoint, detalle, error }) {
  const mensajeError = error?.message || String(error || 'Error desconocido');
  console.error(`[alerta] ${endpoint}${detalle ? ` (${detalle})` : ''}: ${mensajeError}`);

  // Best-effort, nunca bloquea ni tira — alimenta "Monitoreo técnico" en /admin sin
  // depender de revisar el mail. Import dinámico para no crear una dependencia circular
  // ni cargar el cliente OAuth de Pacientes en endpoints que no lo necesitan para nada más.
  // Se espera (await) a propósito: en una función serverless, una promesa sin esperar
  // puede quedar cortada apenas el handler que llamó a avisarFallo() manda la respuesta.
  try {
    const { logAlerta } = await import('./adminConfig.js');
    await logAlerta({ endpoint, detalle, mensaje: mensajeError });
  } catch {
    // nunca romper el endpoint que llamó a avisarFallo() por esto
  }

  if (!process.env.RESEND_API_KEY) return; // Resend no configurado todavía — no romper nada

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Alertas Consultorio <onboarding@resend.dev>',
        to: EMAIL_ALERTA,
        subject: `⚠️ Falló ${endpoint} en el sitio del consultorio`,
        text:
          'Algo falló de verdad (después de reintentar solo varias veces) en el sitio del consultorio.\n\n' +
          `Endpoint: ${endpoint}\n` +
          (detalle ? `Detalle: ${detalle}\n` : '') +
          `Error: ${mensajeError}\n\n` +
          `Hora: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`,
      }),
    });
  } catch (errEnvio) {
    // Si falla el envío del mail de alerta, no hay a quién más avisarle — queda
    // registrado en los logs de Vercel nada más. Nunca se propaga hacia el endpoint que
    // llamó a avisarFallo() (el error real ya se le mostró al usuario igual).
    console.error('[alerta] no se pudo mandar el email de alerta:', errEnvio?.message || errEnvio);
  }
}
