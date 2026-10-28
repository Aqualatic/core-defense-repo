const fs = require('node:fs');
const path = require('node:path');
const packagePath = require.resolve('socket.io-client/package.json');
const source = path.dirname(packagePath);
const target = path.join(__dirname, '../public/vendor');
fs.mkdirSync(target, { recursive: true });
for (const name of ['socket.io.min.js', 'socket.io.min.js.map']) {
  fs.copyFileSync(path.join(source, 'dist', name), path.join(target, name));
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'socket.io.LICENSE'));
console.log('Bundled Socket.IO client ' + require(packagePath).version + ' with its license.');
