// api/notificar-update.js
// Notifica a todos los usuarios de ROS sobre una nueva actualización
// Uso: POST https://app.getros.mx/api/notificar-update
// Body: { "secret": "TU_ADMIN_SECRET", "titulo": "...", "mensaje": "...", "version": "..." }

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Verificar secret de admin ─────────────────────────────────────────────
  const { secret, titulo, mensaje, version } = req.body;

  if (secret !== process.env.ADMIN_NOTIFY_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!titulo || !mensaje) {
    return res.status(400).json({ error: 'titulo y mensaje son requeridos' });
  }

  // ── Obtener todos los usuarios de Supabase ────────────────────────────────
  const SB_URL = process.env.SUPABASE_URL;
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  let usuarios = [];
  try {
    // Obtener lista de usuarios desde Supabase Auth (requiere service key)
    const resp = await fetch(`${SB_URL}/auth/v1/admin/users?per_page=1000`, {
      headers: {
        'apikey': SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      }
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(500).json({ error: 'Error obteniendo usuarios de Supabase', detalle: err });
    }

    const data = await resp.json();
    usuarios = data.users || [];
  } catch (e) {
    return res.status(500).json({ error: 'Error conectando con Supabase', detalle: e.message });
  }

  if (usuarios.length === 0) {
    return res.status(200).json({ ok: true, enviados: 0, mensaje: 'No hay usuarios registrados' });
  }

  // ── Enviar correo a cada usuario con Resend ───────────────────────────────
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const versLabel = version ? ` — ${version}` : '';

  let enviados = 0;
  let errores = [];

  for (const usuario of usuarios) {
    const email = usuario.email;
    if (!email) continue;

    try {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'ROS — Restaurant Operating System <hola@getros.mx>',
          to: [email],
          subject: `🚀 Nueva actualización en ROS${versLabel}: ${titulo}`,
          html: emailHTML(titulo, mensaje, version),
        }),
      });

      if (emailResp.ok) {
        enviados++;
      } else {
        const err = await emailResp.text();
        errores.push({ email, error: err });
      }
    } catch (e) {
      errores.push({ email, error: e.message });
    }

    // Pequeña pausa para no saturar la API de Resend (10 emails/seg max en plan gratuito)
    await new Promise(r => setTimeout(r, 120));
  }

  return res.status(200).json({
    ok: true,
    total_usuarios: usuarios.length,
    enviados,
    errores: errores.length,
    detalle_errores: errores.length > 0 ? errores : undefined,
  });
}

// ── Template del correo ───────────────────────────────────────────────────────
function emailHTML(titulo, mensaje, version) {
  const versLabel = version ? `<span style="background:#1a1a00;color:#e8c547;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600">${version}</span>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:14px;border:1px solid #2a2a2a;overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a1a00,#252510);padding:28px 32px;border-bottom:2px solid #e8c547">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-family:'Syne',Arial,sans-serif;font-size:22px;font-weight:800;color:#e8c547;letter-spacing:-0.5px">R.O.S</div>
                  <div style="font-size:11px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-top:2px">Restaurant Operating System</div>
                </td>
                <td align="right">
                  ${versLabel}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px">
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Nueva actualización</div>
            <h1 style="font-size:20px;font-weight:700;color:#f0f0f0;margin:0 0 16px">${titulo}</h1>
            <div style="font-size:14px;color:#aaa;line-height:1.75;white-space:pre-line">${mensaje}</div>

            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" style="margin-top:28px">
              <tr>
                <td style="background:#e8c547;border-radius:8px">
                  <a href="https://app.getros.mx" style="display:block;padding:12px 28px;color:#000;font-size:14px;font-weight:700;text-decoration:none">Ver la actualización →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Discord -->
        <tr>
          <td style="padding:0 32px 20px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(88,101,242,0.12);border:1px solid rgba(88,101,242,0.3);border-radius:8px">
              <tr>
                <td style="padding:14px 18px">
                  <span style="font-size:13px;color:#8891f7">💬 ¿Tienes dudas sobre esta actualización? Únete a la comunidad en </span>
                  <a href="https://discord.gg/Gf2tufwp4" style="color:#8891f7;font-weight:600">Discord ROS</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #222">
            <p style="font-size:11px;color:#555;margin:0;line-height:1.6">
              Recibiste este correo porque tienes una suscripción activa en ROS.<br>
              <a href="https://www.getros.mx" style="color:#666">www.getros.mx</a> · 
              <a href="mailto:hola@getros.mx" style="color:#666">hola@getros.mx</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
