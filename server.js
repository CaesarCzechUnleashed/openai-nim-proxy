const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// CORS - allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

const IFLOW_API_KEY = process.env.IFLOW_API_KEY;
const IFLOW_BASE_URL = 'https://apis.iflow.cn/v1';

// Model mapping - all models use deepseek-v3.2
const MODELS = {
  'gpt-3.5-turbo': 'deepseek-v3.2',
  'gpt-4': 'deepseek-v3.2',
  'gpt-4-turbo': 'deepseek-v3.2',
  'gpt-4o': 'deepseek-v3.2',
  'claude-3-opus': 'deepseek-v3.2',
  'claude-3-sonnet': 'deepseek-v3.2',
  'gemini-pro': 'deepseek-v3.2',
  'deepseek-v3.2': 'deepseek-v3.2'
};

// Creative writing system prompt - FORCE ENGLISH
const CREATIVE_WRITING_PROMPT = {
  role: 'system',
  content: 'You must respond ONLY in English. You are a creative writing assistant. Write engaging, vivid narratives. Do not show reasoning or thinking process - provide direct creative responses. Focus on immersive storytelling.'
};

// Root endpoint
app.all('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'iFlow Proxy is running',
    version: '1.0.0'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'iflow-proxy' });
});

// List models
app.get('/v1/models', (req, res) => {
  const modelList = Object.keys(MODELS).map(id => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: 'iflow'
  }));
  res.json({ object: 'list', data: modelList });
});

// Function to remove reasoning content
function cleanResponse(text) {
  if (!text) return text;
  
  // Remove <think>...</think> blocks
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // Remove reasoning markers
  cleaned = cleaned.replace(/\[Reasoning\][\s\S]*?\[\/Reasoning\]/gi, '');
  cleaned = cleaned.replace(/\[思考\][\s\S]*?\[\/思考\]/gi, '');
  
  // Remove thinking tags
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

// Main chat function
async function processChat(req, res) {
  try {
    console.log('Received chat request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    if (!IFLOW_API_KEY) {
      console.error('IFLOW_API_KEY not set');
      return res.status(500).json({
        error: {
          message: 'iFlow API key not configured',
          type: 'server_error'
        }
      });
    }

    let { model, messages, temperature, max_tokens, stream = false } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: {
          message: 'Missing required fields: model and messages',
          type: 'invalid_request_error'
        }
      });
    }

    // Map model name
    const iflowModel = MODELS[model] || 'deepseek-v3.2';
    console.log(`Mapping ${model} -> ${iflowModel}`);

    // Creative writing optimized defaults
    const finalTemperature = temperature !== undefined ? temperature : 0.9;
    const finalMaxTokens = max_tokens || 8192;

    // Prepend creative writing system prompt
    let finalMessages = [...messages];
    if (finalMessages[0]?.role !== 'system') {
      finalMessages.unshift(CREATIVE_WRITING_PROMPT);
    } else {
      // Add English requirement to existing system prompt
      finalMessages[0].content = 'IMPORTANT: Respond ONLY in English. Do not show reasoning. ' + finalMessages[0].content;
    }

    // Call iFlow API - ONLY standard OpenAI parameters
    const iflowRequest = {
      model: iflowModel,
      messages: finalMessages,
      temperature: finalTemperature,
      max_tokens: finalMaxTokens,
      stream: stream
    };

    console.log('Calling iFlow API...');
    const response = await axios.post(
      `${IFLOW_BASE_URL}/chat/completions`,
      iflowRequest,
      {
        headers: {
          'Authorization': `Bearer ${IFLOW_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json',
        timeout: 180000
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Filter streaming response
      let buffer = '';
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            try {
              if (line.includes('[DONE]')) {
                res.write(line + '\n');
                return;
              }
              
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                // Clean reasoning from streaming content
                data.choices[0].delta.content = cleanResponse(data.choices[0].delta.content);
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Clean non-streaming response
      const iflowData = response.data;
      
      // Remove reasoning content from response
      if (iflowData.choices) {
        iflowData.choices = iflowData.choices.map(choice => {
          if (choice.message?.content) {
            choice.message.content = cleanResponse(choice.message.content);
          }
          return choice;
        });
      }
      
      console.log('Sending cleaned response');
      res.json(iflowData);
    }

  } catch (error) {
    console.error('Error details:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    const status = error.response?.status || 500;
    const errorMessage = error.response?.data?.error?.message || error.response?.data?.detail || error.message || 'Unknown error';

    res.status(status).json({
      error: {
        message: errorMessage,
        type: 'api_error',
        code: status
      }
    });
  }
}

// Handle POST to /v1
app.post('/v1', processChat);

// Main chat endpoint
app.post('/v1/chat/completions', processChat);

// Catch all other routes
app.all('*', (req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: {
      message: `Route not found: ${req.path}`,
      type: 'invalid_request_error'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 iFlow API Key: ${IFLOW_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`🎨 Mode: Creative Writing (English, reasoning filtered)`);
});
