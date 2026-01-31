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
// gemini-3-flash: balanced model (speed + frontier intelligence)
// gemini-3-pro: most powerful Google reasoning model
// Using stable version for production reliability
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-3-flash' });

const mistral = new Mistral({
  apiKey: config.mistralApiKey
});

const perplexity = new OpenAI({
  apiKey: config.perplexityApiKey,
  baseURL: 'https://api.perplexity.ai'
});

export { openai, grok, claude, geminiModel, mistral, perplexity };
