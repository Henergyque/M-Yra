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
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

const mistral = new Mistral({
  apiKey: config.mistralApiKey
});

const perplexity = new OpenAI({
  apiKey: config.perplexityApiKey,
  baseURL: 'https://api.perplexity.ai'
});

export { openai, grok, claude, geminiModel, mistral, perplexity };
