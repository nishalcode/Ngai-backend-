##NGAI Chatbot Backend

A production-ready SSE (Server-Sent Events) streaming backend for AI chatbots using OpenRouter's free models. Features real-time streaming, session management, and robust error handling.

https://img.shields.io/badge/Node.js-18+-green
https://img.shields.io/badge/Express-4.x-blue
https://img.shields.io/badge/License-MIT-yellow
https://img.shields.io/badge/OpenRouter-API-purple

✨ Features

· Real-time SSE Streaming: Efficient server-sent events for live AI responses
· OpenRouter Integration: Access to 100+ AI models including free options
· Session Management: Secure session-based communication flow
· Production Ready: Robust error handling, CORS, memory leak prevention
· Two-Step Flow: POST-then-GET architecture for reliable streaming
· Automatic Cleanup: Session timeout and resource management

🚀 Quick Start

1. Prerequisites

· Node.js 18 or higher
· OpenRouter API key (free at OpenRouter.ai)

2. Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/ngai-chatbot-backend.git
cd ngai-chatbot-backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

3. Configure Environment

Edit .env file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
# Optional:
# REFERER=https://your-domain.com
# X_TITLE=NGAI Chatbot Backend
# PORT=3000
```

4. Run the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

Server will start at: http://localhost:3000

📚 API Reference

1. Create a Session

POST /prepare

```json
{
  "model": "mistralai/mistral-7b-instruct:free",
  "messages": [
    {"role": "user", "content": "Hello, how are you?"}
  ]
}
```

Response:

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

2. Stream Responses

GET /stream/:sessionId

Server-Sent Events endpoint that streams AI responses:

Events:

· chunk: AI response chunks (JSON format)
· done: Stream completion
· error: Error messages

Example Client Code:

```javascript
const es = new EventSource(`http://localhost:3000/stream/${sessionId}`);

es.addEventListener('chunk', (e) => {
  const data = JSON.parse(e.data);
  console.log(data.choices[0]?.delta?.content || '');
});

es.addEventListener('done', () => {
  console.log('Stream completed');
  es.close();
});

es.addEventListener('error', (e) => {
  console.error('Error:', JSON.parse(e.data));
});
```

3. List Available Models

GET /models

Returns all available OpenRouter models with pricing and capabilities.

🔧 Available Models

Popular free models (no credit card needed):

· mistralai/mistral-7b-instruct:free
· google/gemma-7b-it:free
· huggingfaceh4/zephyr-7b-beta:free
· openchat/openchat-7b:free

See /models endpoint for complete list.

🎯 Usage Example

Frontend Integration

```javascript
async function chatWithAI(message) {
  // Step 1: Create session
  const prepResponse = await fetch('http://localhost:3000/prepare', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'mistralai/mistral-7b-instruct:free',
      messages: [{role: 'user', content: message}]
    })
  });
  
  const {sessionId} = await prepResponse.json();
  
  // Step 2: Stream response
  const eventSource = new EventSource(`http://localhost:3000/stream/${sessionId}`);
  let fullResponse = '';
  
  eventSource.addEventListener('chunk', (event) => {
    const data = JSON.parse(event.data);
    const chunk = data.choices?.[0]?.delta?.content || '';
    fullResponse += chunk;
    // Update UI with new chunk
    document.getElementById('response').textContent = fullResponse;
  });
  
  eventSource.addEventListener('done', () => {
    eventSource.close();
    console.log('Conversation complete');
  });
  
  eventSource.addEventListener('error', (error) => {
    console.error('Stream error:', JSON.parse(error.data));
    eventSource.close();
  });
}
```

📁 Project Structure

```
ngai-chatbot-backend/
├── server.js              # Main server file
├── package.json          # Dependencies
├── .env.example          # Environment template
├── .env                  # Environment variables (create this)
├── .gitignore           # Git ignore rules
└── README.md            # This file
```

🛠️ Deployment

Railway.app (Recommended)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

Vercel

Create vercel.json:

```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/server.js"
    }
  ]
}
```

Render.com

· New Web Service
· Connect GitHub repository
· Set build command: npm install
· Set start command: npm start
· Add environment variables

🔒 Environment Variables

Variable Required Default Description
OPENROUTER_API_KEY Yes - Your OpenRouter API key
REFERER No Client origin Referer header for OpenRouter
X_TITLE No NGAI Chatbot Backend X-Title header for OpenRouter
PORT No 3000 Server port

⚠️ Troubleshooting

Common Issues:

1. "Missing OPENROUTER_API_KEY"
   · Ensure .env file exists with correct API key
   · Restart server after updating .env
2. CORS Errors
   · Update CORS origin in server.js to match your frontend domain
   · Ensure correct headers are sent
3. Stream Disconnects
   · Check network stability
   · Verify session IDs are valid and not expired
   · Monitor server logs for errors
4. Rate Limiting
   · OpenRouter free tier has limits
   · Consider implementing client-side rate limiting

📊 Performance

· Memory Efficient: Automatic session cleanup (10-minute timeout)
· Scalable: Stateless design, easy to scale horizontally
· Low Latency: Direct SSE streaming with minimal overhead

🤝 Contributing

1. Fork the repository
2. Create a feature branch (git checkout -b feature/AmazingFeature)
3. Commit changes (git commit -m 'Add AmazingFeature')
4. Push to branch (git push origin feature/AmazingFeature)
5. Open a Pull Request

📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

🙏 Acknowledgments

· OpenRouter for providing free AI model access
· Express.js team for the robust web framework
· All contributors and users of this project

📞 Support

For support, email niishaldas@gmail.com or open an issue in the GitHub repository.

---

Built with ❤️ by Nishal | NGAI
Making AI accessible and real-time for everyone

🚀 Quick Links

· OpenRouter Dashboard
· OpenRouter Models
· SSE Specification
· Express.js Documentation

---

⭐ Star this repo if you found it useful! ⭐
