// localStorage is shared by everyone who uses this browser and survives
// logout, but Melidrop keeps per-user data there: Mercado Libre and Amazon
// keys, pricing rules, filters. Confirmed live: on a shared computer a newly
// registered account started out with the previous user's cached Mercado
// Libre keys, renewed them, and saved that user's ML account into its own
// row. So the cache records whose it is, and is dropped when someone else
// signs in.

const OWNER_KEY = 'melidrop_cache_owner';
const USER_KEY_PREFIXES = ['melidrop_', 'temp_meli_', 'ml_test_oauth'];

export function clearUserCache(): void {
    for (const key of Object.keys(localStorage)) {
        if (USER_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
    }
    sessionStorage.removeItem('test_oauth_verifier');
}

// Call once the signed-in user's user_connections row is known (null if they
// have none). Returns true if the cache belonged to someone else and was
// cleared. A cache from before ownership was tracked is judged by the
// Mercado Libre account it holds: if it isn't the one saved for this user,
// it isn't theirs.
export function claimUserCache(userId: string, savedMeliUserId?: string | number | null): boolean {
    const owner = localStorage.getItem(OWNER_KEY);
    let foreign = !!owner && owner !== userId;
    if (!owner) {
        try {
            const cached = JSON.parse(localStorage.getItem('melidrop_meli_credentials') || 'null');
            foreign = !!cached?.id && String(cached.id) !== String(savedMeliUserId ?? '');
        } catch {
            foreign = true;
        }
    }
    if (foreign) clearUserCache();
    localStorage.setItem(OWNER_KEY, userId);
    return foreign;
}
