import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Mistral } from '@mistralai/mistralai';
import { config } from '../config.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

const grok = new OpenAI({
  apiKey: config.grokApiKey,
  baseURL: 'https://api.x.ai/v1'
});

const Anthropic = await import('@anthropic-ai/sdk');
const claude = new Anthropic.default({
  apiKey: config.claudeApiKey
});

const gemini = new GoogleGenerativeAI(config.geminiApiKey);
// gemini-flash-latest: latest Flash model alias
// gemini-3-pro: most powerful Google reasoning model
// Using latest alias for automatic updates
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-flash-latest' });

const mistral = new Mistral({
  apiKey: config.mistralApiKey
});

export { openai, grok, claude, geminiModel, mistral };
