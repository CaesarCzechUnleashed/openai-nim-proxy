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

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Simple model mapping - using models that definitely work
const MODELS = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct', 
  'gpt-4-turbo': 'meta/llama-3.3-70b-instruct',
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct',
  'gemini-pro': 'meta/llama-3.3-70b-instruct'
};

// Root endpoint - handles all methods
app.all('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'NVIDIA NIM Proxy is running',
    version: '1.0.0'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nvidia-proxy' });
});

// List models (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const modelList = Object.keys(MODELS).map(id => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia'
  }));
  res.json({ object: 'list', data: modelList });
});

// Main chat endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('Received chat request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    if (!NVIDIA_API_KEY) {
      console.error('NVIDIA_API_KEY not set');
      return res.status(500).json({
        error: {
          message: 'NVIDIA API key not configured',
          type: 'server_error'
        }
      });
    }

    const { model, messages, temperature = 0.7, max_tokens = 1024, stream = false } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: {
          message: 'Missing required fields: model and messages',
          type: 'invalid_request_error'
        }
      });
    }

    // Map model name
    const nvidiaModel = MODELS[model] || MODELS['gpt-4'];
    console.log(`Mapping ${model} -> ${nvidiaModel}`);

    // Call NVIDIA API
    const nvidiaRequest = {
      model: nvidiaModel,
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      stream: stream
    };

    console.log('Calling NVIDIA API...');
    const response = await axios.post(
      `${NVIDIA_BASE_URL}/chat/completions`,
      nvidiaRequest,
      {
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      // Stream response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      // Regular response - convert to OpenAI format
      const nvidiaData = response.data;
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: nvidiaData.choices || [{
          index: 0,
          message: {
            role: 'assistant',
            content: nvidiaData.choices?.[0]?.message?.content || 'Error: No response'
          },
          finish_reason: 'stop'
        }],
        usage: nvidiaData.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      console.log('Sending response');
      res.json(openaiResponse);
    }

  } catch (error) {
    console.error('Error details:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    const status = error.response?.status || 500;
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';

    res.status(status).json({
      error: {
        message: errorMessage,
        type: 'api_error',
        code: status
      }
    });
  }
});

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
  console.log(`🔑 NVIDIA API Key: ${NVIDIA_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
});
