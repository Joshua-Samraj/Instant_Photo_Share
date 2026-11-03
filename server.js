const app = require('./src/app');
const config = require('./src/config');

if (require.main === module) {
    app.listen(config.port, () => {
        console.log(`SnapSync API listening on http://localhost:${config.port}`);
        console.log(`Face service: ${config.aiUrl}`);
    });
}

module.exports = app;
