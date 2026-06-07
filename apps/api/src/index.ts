import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

if (!process.env.GROQ_API_KEY) {
  console.error('GROQ_API_KEY is not set. Please add it to your .env file.');
  process.exit(1);
}

import { app } from './server';

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`GitGuide API running on http://localhost:${PORT}`);
});
