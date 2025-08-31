import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import realtimeRoutes from './routes/realtime';
import toolRoutes from './routes/tools';
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import sessionRoutes from './routes/sessions';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));
app.use(cookieParser());

// Mount route stubs (will be implemented step-by-step)
app.use(realtimeRoutes);
app.use(toolRoutes);
app.use(authRoutes);
app.use(userRoutes);
app.use(sessionRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT || 4500);
app.listen(PORT, () => {
  console.log(`TS server running at http://localhost:${PORT}`);
});


