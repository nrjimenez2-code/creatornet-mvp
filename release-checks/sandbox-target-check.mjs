if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_TARGET_ENV !== 'mentorship-sandbox') { console.error('Isolated sandbox target check failed'); process.exitCode = 1; }
