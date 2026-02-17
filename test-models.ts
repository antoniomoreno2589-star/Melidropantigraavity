import { AIService } from './services/aiService';

const service = new AIService();

async function listModels() {
    // @ts-ignore
    const key = 'AIzaSyAkztkTlqDmg8ccksBSjysro5bvCbm-9vY';
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        console.log("Available Models:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Error listing models:", e);
    }
}

listModels();
