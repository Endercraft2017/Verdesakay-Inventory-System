/** Server entry point: initialize the database, then start listening. */
import os from 'node:os';
import { init, cleanupSessions } from './src/db';
import { createApp } from './src/app';

init();
setInterval(cleanupSessions, 60 * 60 * 1000).unref(); // hourly

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIps: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
    }
  }
  console.log('\nVerdesakay Office System is running:');
  console.log(`   Local:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`   Network: http://${ip}:${PORT}  (for other office PCs)`);
  console.log('');
});
