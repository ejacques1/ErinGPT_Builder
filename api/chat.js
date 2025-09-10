// api/chat.js - Vercel Serverless Function
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, instructions, context, model = 'openai/gpt-4o-mini' } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Prepare system message with instructions and context
    let systemContent = instructions || 'You are a helpful assistant.';
    
    if (context) {
      systemContent += `\n\nRelevant information from uploaded documents:\n${context}`;
    }

    // Prepare messages for OpenRouter
    const openRouterMessages = [
      { role: 'system', content: systemContent },
      ...messages
    ];

    // Call OpenRouter API with your secure API key
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer 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`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: openRouterMessages,
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'OpenRouter API error');
    }

    // Return the AI response
    res.status(200).json({
      success: true,
      message: data.choices[0]?.message?.content || 'No response generated',
      usage: data.usage
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to process request',
      details: error.message 
    });
  }
}
