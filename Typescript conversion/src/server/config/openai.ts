import OpenAI from 'openai';
import { env } from '../env';

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export const REALTIME_MODEL = env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
export const SUMMARY_MODEL = env.OPENAI_SUMMARY_MODEL || 'gpt-4o';


