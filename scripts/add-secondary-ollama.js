import { loadConfig, saveConfig } from '../config-loader.js';

const newUrl = process.argv[2];

if (!newUrl) {
    console.error('Usage: node scripts/add-secondary-ollama.js <url>');
    console.error('Example: node scripts/add-secondary-ollama.js http://127.0.0.1:11435');
    process.exit(1);
}

const config = loadConfig();
if (!config.vectorSearch) {
    config.vectorSearch = {};
}

console.log(`Current primary URL: ${config.vectorSearch.ollamaUrl}`);
console.log(`Current secondary URL: ${config.vectorSearch.ollamaUrlSecondary || '(none)'}`);

config.vectorSearch.ollamaUrlSecondary = newUrl;

if (saveConfig(config)) {
    console.log(`
[SUCCESS] Updated config.json with secondary Ollama URL: ${newUrl}`);
    console.log('You can now run "npm run vector:backfill" to use both instances.');
} else {
    console.error('
[ERROR] Failed to save configuration.');
}
