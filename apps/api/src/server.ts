import express from 'express';
import cors from 'cors';
import { analyzeRouter } from './routes/analyze';
import { chatRouter } from './routes/chat';
import { explainRepoRouter } from './routes/explain-repo';
import { explainFileRouter } from './routes/explain-file';
import { goodFirstIssuesRouter } from './routes/good-first-issues';

export const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        /^chrome-extension:\/\//.test(origin) ||
        /^https:\/\/github\.com$/.test(origin) ||
        origin === 'http://localhost:5173'
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  }),
);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/v1/analyze', analyzeRouter);
app.use('/v1/chat', chatRouter);
app.use('/v1/explain-repo', explainRepoRouter);
app.use('/v1/explain-file', explainFileRouter);
app.use('/v1/good-first-issues', goodFirstIssuesRouter);
