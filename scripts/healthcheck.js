require('dotenv').config();

const base = process.env.HEALTH_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

(async () => {
    try {
        const response = await fetch(`${base}/api/health?deep=1`);
        const data = await response.json();
        console.log(JSON.stringify(data, null, 2));
        process.exit(data.ok ? 0 : 1);
    } catch (error) {
        console.error(`Health check failed: ${error.message}`);
        process.exit(1);
    }
})();
