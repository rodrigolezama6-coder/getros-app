// api/mcp.js
// Conector MCP (Streamable HTTP, sin estado) para que Claude lea y publique
// en el servidor de Discord "Grupo Attico" a través del bot "Grupo Attico Bot".
//
// Variables de entorno en Vercel:
//   DISCORD_BOT_TOKEN  token del bot (Developer Portal → Bot → Reset Token)
//   MCP_KEY            clave larga y secreta; el conector se agrega en Claude como
//                      https://getros.mx/api/mcp?key=<MCP_KEY>
//   DISCORD_GUILD_ID   opcional, por default el servidor Grupo Attico

const API = 'https://discord.com/api/v10';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1569438206603038951';
const TZ = 'America/Mexico_City';

// ---------- Discord REST ----------
async function discord(path, options = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('Falta DISCORD_BOT_TOKEN en Vercel');
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(API + path, {
      ...options,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GrupoAtticoBot (https://getros.mx, 1.0)',
        ...(options.headers || {}),
      },
    });
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, Math.ceil((body.retry_after || 1) * 1000)));
      continue;
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Discord ${resp.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Discord: demasiadas solicitudes, intenta de nuevo');
}

let channelCache = null;
async function getChannels() {
  if (channelCache && Date.now() - channelCache.at < 60_000) return channelCache.list;
  const all = await discord(`/guilds/${GUILD_ID}/channels`);
  const categories = Object.fromEntries(all.filter(c => c.type === 4).map(c => [c.id, c.name]));
  const list = all
    .filter(c => c.type === 0 || c.type === 5)
    .map(c => ({
      id: c.id,
      name: c.name,
      category: categories[c.parent_id] || null,
      position: c.position,
      parent_position: (all.find(p => p.id === c.parent_id) || {}).position ?? -1,
    }))
    .sort((a, b) => a.parent_position - b.parent_position || a.position - b.position)
    .map(({ position, parent_position, ...c }) => c);
  channelCache = { at: Date.now(), list };
  return list;
}

async function resolveChannel(ref) {
  if (!ref) throw new Error('Falta el canal');
  const clean = String(ref).replace(/^#/, '').trim().toLowerCase();
  if (/^\d{15,}$/.test(clean)) return clean;
  const list = await getChannels();
  const hit = list.find(c => c.name.toLowerCase() === clean);
  if (!hit) throw new Error(`No encontré el canal "${ref}" (o el bot no tiene acceso)`);
  return hit.id;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-MX', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
}

function simplifyMessage(m) {
  return {
    id: m.id,
    author: m.member?.nick || m.author?.global_name || m.author?.username,
    author_id: m.author?.id,
    is_bot: !!m.author?.bot,
    time: fmtDate(m.timestamp),
    timestamp: m.timestamp,
    content: m.content,
    attachments: (m.attachments || []).map(a => ({ name: a.filename, url: a.url })),
    reactions: (m.reactions || []).map(r => ({ emoji: r.emoji?.name, count: r.count })),
    reply_to: m.referenced_message?.id || null,
    thread_id: m.thread?.id || null,
  };
}

async function readMessages(channelId, sinceHours, maxMessages) {
  const cutoff = Date.now() - sinceHours * 3600 * 1000;
  const out = [];
  let before = null;
  while (out.length < maxMessages) {
    const q = new URLSearchParams({ limit: '100' });
    if (before) q.set('before', before);
    const batch = await discord(`/channels/${channelId}/messages?${q}`);
    if (!batch || batch.length === 0) break;
    let reachedCutoff = false;
    for (const m of batch) {
      if (new Date(m.timestamp).getTime() < cutoff) { reachedCutoff = true; break; }
      out.push(simplifyMessage(m));
      if (out.length >= maxMessages) break;
    }
    if (reachedCutoff || batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  return out.reverse(); // cronológico
}

function splitMessage(text, size = 1900) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------- Herramientas ----------
const TOOLS = [
  {
    name: 'list_channels',
    description: 'Lista los canales de texto del servidor Grupo Attico a los que tiene acceso el bot, con su categoría.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_messages',
    description: 'Lee los mensajes de uno o varios canales en las últimas N horas (orden cronológico). Incluye autor, hora (Ciudad de México), texto, adjuntos y reacciones.',
    inputSchema: {
      type: 'object',
      properties: {
        channels: { type: 'array', items: { type: 'string' }, description: 'Nombres (ej. "operacion-centro") o IDs de canal. Usa ["*"] para todos los canales accesibles.' },
        since_hours: { type: 'number', description: 'Ventana hacia atrás en horas. Default 24.' },
        max_per_channel: { type: 'number', description: 'Máximo de mensajes por canal. Default 200, tope 500.' },
        include_bot_messages: { type: 'boolean', description: 'Incluir mensajes del propio bot. Default false.' },
      },
      required: ['channels'],
    },
  },
  {
    name: 'send_message',
    description: 'Publica un mensaje como "Grupo Attico Bot" en un canal. Textos largos se dividen en varios mensajes. Para mencionar a alguien usa <@ID_de_usuario>.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nombre o ID del canal' },
        content: { type: 'string', description: 'Texto en Markdown de Discord' },
        reply_to: { type: 'string', description: 'Opcional: ID del mensaje al que se responde' },
      },
      required: ['channel', 'content'],
    },
  },
  {
    name: 'get_reactions',
    description: 'Quién reaccionó a un mensaje con un emoji (por ejemplo ✅ para confirmar cifras).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string', description: 'Emoji unicode, default ✅' },
      },
      required: ['channel', 'message_id'],
    },
  },
  {
    name: 'find_member',
    description: 'Busca miembros del servidor por nombre para obtener su ID (necesario para mencionarlos). Requiere "Server Members Intent" activo en el bot.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_channels':
      return await getChannels();

    case 'read_messages': {
      const hours = Math.min(Math.max(Number(args.since_hours) || 24, 0.1), 24 * 45);
      const max = Math.min(Number(args.max_per_channel) || 200, 500);
      let targets = args.channels || [];
      const list = await getChannels();
      if (targets.includes('*')) targets = list.map(c => c.id);
      const result = [];
      for (const ref of targets) {
        try {
          const id = await resolveChannel(ref);
          const meta = list.find(c => c.id === id) || { name: ref, category: null };
          let msgs = await readMessages(id, hours, max);
          if (!args.include_bot_messages) msgs = msgs.filter(m => !m.is_bot);
          if (msgs.length) result.push({ channel: meta.name, category: meta.category, channel_id: id, messages: msgs });
        } catch (e) {
          result.push({ channel: ref, error: e.message });
        }
      }
      return { since_hours: hours, channels_with_activity: result.length, results: result };
    }

    case 'send_message': {
      const id = await resolveChannel(args.channel);
      const parts = splitMessage(String(args.content || ''));
      if (!parts.length) throw new Error('Mensaje vacío');
      const sent = [];
      for (let i = 0; i < parts.length; i++) {
        const body = { content: parts[i], allowed_mentions: { parse: ['users'] } };
        if (i === 0 && args.reply_to) body.message_reference = { message_id: args.reply_to };
        const m = await discord(`/channels/${id}/messages`, { method: 'POST', body: JSON.stringify(body) });
        sent.push(m.id);
      }
      return { ok: true, channel_id: id, message_ids: sent };
    }

    case 'get_reactions': {
      const id = await resolveChannel(args.channel);
      const emoji = encodeURIComponent(args.emoji || '✅');
      const users = await discord(`/channels/${id}/messages/${args.message_id}/reactions/${emoji}?limit=100`);
      return (users || []).map(u => ({ id: u.id, name: u.global_name || u.username }));
    }

    case 'find_member': {
      const q = new URLSearchParams({ query: String(args.query || ''), limit: '10' });
      const members = await discord(`/guilds/${GUILD_ID}/members/search?${q}`);
      return (members || []).map(m => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username, roles: m.roles }));
    }

    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

// ---------- MCP JSON-RPC ----------
async function handleRpc(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notificación
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'grupo-attico-discord', version: '1.0.0' },
          instructions: 'Acceso al Discord interno del Grupo Attico (restaurantes). Horas en zona America/Mexico_City.',
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      try {
        const data = await callTool(params?.name, params?.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
  }
}

function authorized(req) {
  const expected = process.env.MCP_KEY;
  if (!expected || expected.length < 24) return false;
  const url = new URL(req.url, 'http://x');
  const given = url.searchParams.get('key') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'GET') return res.status(405).setHeader('Allow', 'POST').end();
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const batch = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(batch.map(handleRpc))).filter(Boolean);
  if (!responses.length) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
}
