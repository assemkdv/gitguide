// Tests never talk to Groq or GitHub for real; config just needs a key to load.
process.env.GROQ_API_KEY ??= 'test-groq-key';
