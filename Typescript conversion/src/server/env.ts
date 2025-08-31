import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.string().optional(),
  OPENAI_API_KEY: z.string(),
  OPENAI_REALTIME_MODEL: z.string().optional(),
  OPENAI_SUMMARY_MODEL: z.string().optional(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  MYSQL_HOST: z.string().optional(),
  MYSQL_PORT: z.string().optional(),
  MYSQL_USER: z.string().optional(),
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_DB: z.string().optional(),
  JWT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);


