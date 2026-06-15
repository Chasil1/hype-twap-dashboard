try {
  process.loadEnvFile();
  console.log('.env file loaded successfully programmatically.');
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('Failed to load .env file:', err);
  } else {
    console.log('.env file not found (this is expected on production hosting like Railway).');
  }
}
console.log('SUPABASE_URL is:', process.env.SUPABASE_URL ? 'set' : 'NOT set');
