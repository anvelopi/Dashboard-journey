const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'app', 'api', 'auth', '_nextauth');
const dst = path.join(__dirname, 'app', 'api', 'auth', '[...nextauth]');
if (fs.existsSync(src) && !fs.existsSync(dst)) {
  fs.renameSync(src, dst);
  console.log('✅ Renamed _nextauth → [...nextauth]');
}
