// api/chat.js - Secure Vercel Serverless Function
export default async function handler(req, res) {
  // Set CORS headers for cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get API key from environment variables
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY environment variable not set');
      return res.status(500).json({ 
        error: 'Server configuration error',
        details: 'API key not configured' 
      });
    }

    const { messages, instructions, context, model = 'openai/gpt-4o-mini' } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required and cannot be empty' });
    }

    // Prepare system message with instructions and context
    let systemContent = instructions || 'You are a helpful AI assistant.';
    
    if (context && context.trim()) {
      systemContent += `\n\nRelevant information from uploaded documents:\n${context}`;
    }

    // Prepare messages for OpenRouter API
    const openRouterMessages = [
      { role: 'system', content: systemContent },
      ...messages
    ];

    // Call OpenRouter API
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers.origin || 'https://eringptbuilder.com',
        'X-Title': 'ErinGPT Builder'
      },
      body: JSON.stringify({
        model: model,
        messages: openRouterMessages,
        max_tokens: 1500,
        temperature: 0.7,
        stream: false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter API error:', data);
      throw new Error(data.error?.message || `API error: ${response.status}`);
    }

    // Validate response structure
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid response structure from OpenRouter API');
    }

    // Return successful response
    return res.status(200).json({
      success: true,
      message: data.choices[0].message.content,
      model: data.model,
      usage: data.usage || {}
    });

  } catch (error) {
    console.error('Chat API Error:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({ 
      error: 'Failed to process chat request',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
