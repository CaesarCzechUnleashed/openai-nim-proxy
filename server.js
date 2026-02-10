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

    const { model, messages, temperature = 0.7, max_tokens, stream = false } = req.body;

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

    // Set max_tokens
    const finalMaxTokens = max_tokens || 8192;

    // Call iFlow API
    const iflowRequest = {
      model: iflowModel,
      messages: messages,
      temperature: temperature,
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
      response.data.pipe(res);
    } else {
      // Already in OpenAI format, just forward it
      const iflowData = response.data;
      console.log('Sending response');
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
});
