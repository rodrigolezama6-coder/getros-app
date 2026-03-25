// ROS — Webhook de Stripe
// Las keys se leen de variables de entorno de Vercel (seguro)

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function verifyStripeSignature(payload, signature, secret) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).replace('t=', '');
  const sig = parts.find(p => p.startsWith('v1=')).replace('v1=', '');
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (expectedSig !== sig) throw new Error('Firma inválida');
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) throw new Error('Evento expirado');
  return JSON.parse(payload);
}

async function inviteUser(email, restaurantName) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email,
      data: { restaurant_name: restaurantName },
      redirect_to: 'https://app.getros.mx',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || 'Error al crear usuario');
  if (data.id) {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ id: data.id, restaurant_name: restaurantName || 'Mi Restaurante' }),
    });
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'No signature' });
    const event = await verifyStripeSignature(rawBody.toString(), signature, STRIPE_WEBHOOK_SECRET);
    if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true, skipped: true });
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const restaurantName = session.metadata?.restaurant_name || 'Mi Restaurante';
    if (!email) return res.status(400).json({ error: 'No email found' });
    console.log(`Pago recibido — creando cuenta para: ${email}`);
    await inviteUser(email, restaurantName);
    console.log(`Cuenta creada y correo enviado a: ${email}`);
    return res.status(200).json({ received: true, email });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: err.message });
  }
}
