const apiKey = 'AIzaSyAkztkTlqDmg8ccksBSjysro5bvCbm-9vY';
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

async function listModels() {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.log("Error Status:", response.status, response.statusText);
            const text = await response.text();
            console.log("Error Body:", text);
            return;
        }
        const data = await response.json();
        // Just log the names to avoid truncation and noise
        const names = data.models?.map(m => m.name) || [];
        console.log("Available Models:", names.join('\n'));
    } catch (e) {
        console.error("Fetch Error:", e);
    }
}

listModels();
