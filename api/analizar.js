export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'No prompt provided' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Data:', JSON.stringify(data).slice(0, 500));

    if (!response.ok) {
      return res.status(200).json({ text: 'Error Claude: ' + (data.error?.message || JSON.stringify(data)) });
    }

    const text = data.content?.[0]?.text || 'Sin respuesta de Claude.';
    return res.status(200).json({ text });
  } catch (err) {
    console.error('Error:', err);
    return res.status(200).json({ text: 'Error: ' + err.message });
  }
}
