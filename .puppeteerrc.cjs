const { join } = require('path');

// Keep Chrome inside the project so it survives from Render's build step to the running service.
module.exports = { cacheDirectory: join(__dirname, '.cache', 'puppeteer') };
