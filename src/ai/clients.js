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
// gemini-3-flash: le plus équilibré (vitesse + intelligence frontière)
// gemini-3-pro: le MEILLEUR de Google (raisonnement avancé)
// gemini-2.5-flash: stable, excellent prix-performance
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-3-flash-preview-01-2026' });

const mistral = new Mistral({
  apiKey: config.mistralApiKey
});

const perplexity = new OpenAI({
  apiKey: config.perplexityApiKey,
  baseURL: 'https://api.perplexity.ai'
});

export { openai, grok, claude, geminiModel, mistral, perplexity };
