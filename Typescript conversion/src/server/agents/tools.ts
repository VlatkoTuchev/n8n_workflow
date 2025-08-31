import { z } from 'zod';
import { ToolSchema } from './types';

// Avatar controls (no params)
export const setWalkSchema = z.object({});
export const setDanceSchema = z.object({});
export const setFightSchema = z.object({});

// Context
export const getUserContextSchema = z.object({});

// Preferences
export const setPreferredLanguageSchema = z.object({
  userId: z.string(),
  language: z.string().min(1),
});
export const readAgentNameSchema = z.object({});
export const setAgentNameSchema = z.object({ name: z.string().min(1) });
export const readAgentSettingsSchema = z.object({ userId: z.string().optional() });
export const setAgentSettingsSchema = z.object({
  userId: z.string().optional(),
  name: z.string().optional(),
  voice: z.enum(['alloy', 'cedar']).optional(),
  style: z.string().optional(),
});

// Courses
export const listCoursesSchema = z.object({});
export const recommendCoursesSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
  days_ahead: z.number().int().min(1).max(180).optional(),
});

export const toolSchemas: Record<string, ToolSchema> = {
  set_walk: { name: 'set_walk', parameters: setWalkSchema },
  set_dance: { name: 'set_dance', parameters: setDanceSchema },
  set_fight: { name: 'set_fight', parameters: setFightSchema },
  get_user_context: { name: 'get_user_context', parameters: getUserContextSchema },
  set_preferred_language: { name: 'set_preferred_language', parameters: setPreferredLanguageSchema },
  read_agent_name: { name: 'read_agent_name', parameters: readAgentNameSchema },
  set_agent_name: { name: 'set_agent_name', parameters: setAgentNameSchema },
  read_agent_settings: { name: 'read_agent_settings', parameters: readAgentSettingsSchema },
  set_agent_settings: { name: 'set_agent_settings', parameters: setAgentSettingsSchema },
  list_courses: { name: 'list_courses', parameters: listCoursesSchema },
  recommend_courses: { name: 'recommend_courses', parameters: recommendCoursesSchema },
};


